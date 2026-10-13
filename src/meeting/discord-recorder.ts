// 搬自 meeting-recorder/src/discord/recorder.ts
import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from "@discordjs/voice";
import prism from "prism-media";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { VoiceBasedChannel } from "discord.js";
import { RecordingSession, mixTracks, sanitize, spawnPcmToOgg } from "./session.js";

const FRAME_MS = 20;
const FRAME_BYTES = 960 * 2 * 2; // 20ms @ 48k, stereo, s16le
const SILENCE = Buffer.alloc(FRAME_BYTES);

interface UserTrack {
  name: string;
  file: string;
  ffmpeg: ChildProcess;
  writtenFrames: number;
  stream: ReturnType<VoiceConnection["receiver"]["subscribe"]>;
}

/**
 * 進語音頻道，把每個講話的人各錄成一軌 ogg。
 * Discord 靜音時不送封包，所以用牆上時鐘補零對齊時間軸；停止後 amix 混成 mixed.ogg。
 */
export class DiscordRecorder {
  readonly session: RecordingSession;
  private connection: VoiceConnection;
  private tracks = new Map<string, UserTrack>();
  private stopping: Promise<RecordingSession> | null = null;
  onStopped?: (s: RecordingSession) => void;

  constructor(
    readonly project: string,
    readonly channel: VoiceBasedChannel,
  ) {
    this.session = new RecordingSession(project, "discord", `${channel.guild.name}#${channel.name} (${channel.guild.id}/${channel.id})`, channel.name);
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
  }

  async start() {
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (e) {
      this.connection.destroy();
      throw new Error("20 秒內連不上語音頻道。確認 bot 在這個頻道有「連線」權限");
    }
    this.session.event("connected");
    this.connection.receiver.speaking.on("start", (userId) => this.ensureTrack(userId));
    for (const [id, m] of this.channel.members) if (!m.user.bot) this.session.addParticipant({ id, name: m.displayName });
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.session.event("disconnected");
        void this.stop();
      }
    });
  }

  humans(): number {
    return this.channel.members.filter((m) => !m.user.bot).size;
  }

  private ensureTrack(userId: string) {
    if (this.stopping || this.tracks.has(userId)) return;
    const member = this.channel.guild.members.cache.get(userId);
    if (member?.user.bot) return;
    const name = member?.displayName ?? userId;
    const rel = path.join("tracks", `${sanitize(name)}_${userId}.ogg`);
    const file = path.join(this.session.dir, rel);
    const ffmpeg = spawnPcmToOgg(file);
    const stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const track: UserTrack = { name, file, ffmpeg, writtenFrames: 0, stream };
    this.tracks.set(userId, track);
    this.session.addParticipant({ id: userId, name, file: rel });
    this.session.manifest.files.tracks.push(rel);
    this.session.save();

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    decoder.on("data", (pcm: Buffer) => this.writeFrame(track, pcm));
    decoder.on("error", (e) => console.error(`[voice] decoder ${name}:`, e.message));
    stream.on("error", (e) => console.error(`[voice] stream ${name}:`, e.message));
    stream.pipe(decoder);
    console.log(`[voice] track started: ${name}`);
  }

  private writeFrame(track: UserTrack, pcm: Buffer) {
    const stdin = track.ffmpeg.stdin;
    if (!stdin || stdin.destroyed) return;
    const expected = Math.floor((Date.now() - this.session.startedAt) / FRAME_MS);
    const gap = expected - track.writtenFrames;
    // 超過 2 格（40ms）沒資料就補靜音，保持各軌時間軸一致
    if (gap > 2) {
      for (let i = 0; i < gap - 1; i++) stdin.write(SILENCE);
      track.writtenFrames += gap - 1;
    }
    stdin.write(pcm);
    track.writtenFrames++;
  }

  stop(): Promise<RecordingSession> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<RecordingSession> {
    this.session.event("stop");
    const finalFrames = Math.floor((Date.now() - this.session.startedAt) / FRAME_MS);
    const waits: Promise<void>[] = [];
    for (const t of this.tracks.values()) {
      t.stream.destroy();
      const stdin = t.ffmpeg.stdin;
      if (stdin && !stdin.destroyed) {
        while (t.writtenFrames < finalFrames) {
          stdin.write(SILENCE);
          t.writtenFrames++;
        }
        stdin.end();
      }
      waits.push(new Promise((r) => t.ffmpeg.once("exit", () => r())));
    }
    try {
      this.connection.destroy();
    } catch {}
    await Promise.all(waits);
    const files = [...this.tracks.values()].map((t) => t.file);
    if (files.length) {
      await mixTracks(files, path.join(this.session.dir, "mixed.ogg"));
      this.session.manifest.files.mixed = "mixed.ogg";
    }
    this.session.finish();
    console.log(`[voice] saved: ${this.session.dir}`);
    this.onStopped?.(this.session);
    return this.session;
  }
}
