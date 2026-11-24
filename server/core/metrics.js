'use strict';

const os = require('os');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

/**
 * 进程指标（CPU / 内存 / GPU），供 GUI 顶部状态条显示。
 * GPU 采样双通道：
 *   1) nvidia-smi（NVIDIA 专用：利用率 + 显存）
 *   2) typeperf \GPU Engine(*)\Utilization Percentage（Win10+ 系统自带，
 *      NVIDIA/AMD/Intel 通用；按 engtype_VideoEncode/3D/Copy/VideoDecode 聚合）
 * 两路任一可用即显示 GPU pill；typeperf 全 0（无真实 GPU / 核显空闲）时视为不可用。
 */
class Metrics extends EventEmitter {
  constructor(intervalMs = 2000) {
    super();
    this.sample = { cpu: 0, mem: 0, memUsed: 0, memTotal: os.totalmem(), gpu: null, gpuName: '', gpuMemUsed: 0, gpuMemTotal: 0 };
    this.last = null;
    this.gpuAvailable = null;   // null=未探测, false=两路都不可用, true=至少一路可用
    this.typeperfAvailable = null;
    // typeperf 常驻采样：GPU Engine 计数器实例集合会随进程增减重建，
    // 用 -f csv 单次查询模式每次起一个进程太重，改用常驻子进程持续输出。
    this.typeperfProc = null;
    this.typeperfBuf = '';
    this.gpuUtilFromTypeperf = null; // 最近一次聚合结果（0~100 或 null）
    this.typeperfStartedAt = 0;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  tick() {
    const cpu = process.cpuUsage();
    const now = Date.now();
    if (this.last) {
      const elapsedMs = now - this.last.time;
      const user = cpu.user - this.last.cpu.user;
      const sys = cpu.system - this.last.cpu.system;
      const pct = ((user + sys) / 1000) / elapsedMs * 100 / Math.max(1, os.cpus().length);
      this.sample.cpu = Math.min(100, Math.round(pct * 10) / 10);
    }
    this.last = { cpu, time: now };
    this.sample.memUsed = process.memoryUsage().rss;
    this.sample.memTotal = os.totalmem();
    this.sample.mem = Math.round((this.sample.memUsed / this.sample.memTotal) * 1000) / 10;
    this.sample.load = os.loadavg()[0];
    // spawn 在内存紧张时可能同步抛 ENOMEM——采样失败不能带崩服务端进程
    try { this.startTypeperf(); } catch (_) { this.typeperfAvailable = false; }
    // GPU 采样异步补齐后再广播（失败静默，不影响 CPU/内存推送）
    let gpuPr;
    try { gpuPr = this.sampleGpu(); } catch (_) { gpuPr = Promise.resolve(null); }
    gpuPr.then((gpu) => {
      const tUtil = this.gpuUtilFromTypeperf;
      if (gpu) {
        // nvidia-smi 为主（有精确利用率+显存），typeperf 结果仅在其更高时采纳
        this.sample.gpu = Math.max(gpu.util, tUtil != null ? Math.round(tUtil) : 0) || gpu.util;
        this.sample.gpuName = gpu.name;
        this.sample.gpuMemUsed = gpu.memUsed;
        this.sample.gpuMemTotal = gpu.memTotal;
        this.gpuAvailable = true;
      } else if (tUtil != null) {
        this.sample.gpu = Math.round(tUtil);
        this.sample.gpuMemUsed = 0;
        this.sample.gpuMemTotal = 0;
        if (!this.sample.gpuName) this.sample.gpuName = 'GPU（系统计数器）';
        this.gpuAvailable = true;
      } else {
        this.sample.gpu = null;
        this.gpuAvailable = false;
      }
      this.emit('sample', this.sample);
    });
  }

  /**
   * 常驻 typeperf 采样 GPU Engine 利用率（多厂商通用）。
   * 输出为 PDH-CSV 行：每行一个采样点，列 = 各 (pid_x_luid_y_engtype_Z) 实例。
   * 聚合策略：engtype_VideoEncode + VideoDecode + Copy + 3D 全部求和（去重引擎），
   * 全 0 连续多次则判定无真实 GPU 负载/无 GPU。
   */
  startTypeperf() {
    if (this.typeperfProc || this.typeperfAvailable === false) return;
    let settled = false;
    let p;
    try {
      p = spawn('typeperf', [
        '\\GPU Engine(*)\\Utilization Percentage',
        '-si', '2', '-f', 'csv', '-o', '-'
      ], { windowsHide: true, shell: true });
    } catch (_) {
      // 内存紧张等 spawn 失败：本轮放弃且不再重试，避免定时器反复抛异常拖垮进程
      this.typeperfAvailable = false;
      this.typeperfProc = null;
      return;
    }
    this.typeperfProc = p;
    this.typeperfStartedAt = Date.now();
    const fail = () => {
      if (settled) return;
      settled = true;
      this.typeperfAvailable = false;
      this.typeperfProc = null;
    };
    p.on('error', fail);
    p.stderr.on('data', () => { /* 忽略警告 */ });
    p.stdout.on('data', (d) => {
      this.typeperfBuf += d.toString();
      const lines = this.typeperfBuf.split(/\r?\n/);
      this.typeperfBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line || !line.includes('GPU Engine')) continue;
        if (line.startsWith('"(PDH-CSV')) { this.typeperfAvailable = true; settled = true; continue; }
        // 数据行："timestamp","\\PC\GPU Engine(pid_10664_..._engtype_3D)\Utilization Percentage",...
        const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
        let sum = 0;
        let sawCounter = false;
        for (let i = 1; i < cols.length; i++) {
          const c = cols[i];
          if (!c || !c.includes('GPU Engine')) continue;
          const t = c.toLowerCase();
          // 只聚合与视频/图形相关的引擎类型（engtype_Prohibited 全 0 忽略无妨）
          if (!/engtype_(videoencode|videodecode|copy|3d|videoprocessing)/.test(t)) continue;
          const v = Number(cols[i + 1] !== undefined ? String(cols[i + 1]).replace(/^"|"$/g, '') : NaN);
          if (!Number.isFinite(v)) continue;
          sawCounter = true;
          sum += v;
        }
        if (sawCounter) this.gpuUtilFromTypeperf = Math.min(100, sum);
      }
    });
    p.on('close', () => { if (this.typeperfProc === p) this.typeperfProc = null; });
  }

  /**
   * nvidia-smi 查询 GPU 利用率与显存。返回 null 表示不可用。
   */
  sampleGpu() {
    if (this.gpuAvailable === false) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      let out = '';
      // nvidia-smi.exe 位于 System32（PATH 可见），但 .bat/.cmd 需要 shell 才能解析；
      // 用 shell:true 兼容测试桩与未来可能的包装脚本
      let p;
      try {
        p = spawn('nvidia-smi', [
          '--query-gpu=name,utilization.gpu,memory.used,memory.total',
          '--format=csv,noheader,nounits'
        ], { windowsHide: true, shell: true });
      } catch (_) {
        clearTimeout(timer);
        this.nvidiaAvailable = false;
        return done(null);
      }
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} done(null); }, 3000);
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('error', () => { clearTimeout(timer); this.nvidiaAvailable = false; done(null); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { if (this.nvidiaAvailable === undefined) this.nvidiaAvailable = false; return done(null); }
        const line = out.trim().split(/\r?\n/)[0] || '';
        // name 里不含逗号（NVIDIA 命名惯例）；查询顺序 = name,utilization.gpu,memory.used,memory.total
        // → 末三项依次为 利用率 / 已用显存 / 总显存
        const parts = line.split(',').map((s) => s.trim());
        if (parts.length < 4) return done(null);
        const util = Number(parts[parts.length - 3]);
        const memUsed = Number(parts[parts.length - 2]);
        const memTotal = Number(parts[parts.length - 1]);
        const name = parts.slice(0, parts.length - 3).join(',').trim();
        if (!Number.isFinite(util) || !Number.isFinite(memUsed) || !Number.isFinite(memTotal)) return done(null);
        this.nvidiaAvailable = true;
        done({ util: Math.min(100, Math.round(util)), name, memUsed, memTotal });
      });
    });
  }

  current() { return this.sample; }
}

module.exports = { Metrics };
