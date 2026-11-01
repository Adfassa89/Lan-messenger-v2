'use strict';
// Remote help: moves the mouse and presses keys on this PC for a colleague
// the user has allowed to control it. Electron cannot do that itself, so on
// Windows a small PowerShell helper calls the Windows input functions
// (SetCursorPos, mouse_event, keybd_event). It reads one command per line:
//   m X Y        move the mouse to screen pixel X, Y
//   d l|r|m      press a mouse button      u l|r|m   release it
//   w N          turn the wheel by N (120 = one notch, up)
//   k VK 1|0 E   key VK down (1) or up (0); E = 1 for extended keys
const { spawn } = require('child_process');

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LmInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
}
"@
[void][LmInput]::SetProcessDPIAware()
[Console]::Out.WriteLine('ready')
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null) { break }
  $p = $l.Split(' ')
  try {
    switch ($p[0]) {
      'm' { [void][LmInput]::SetCursorPos([int]$p[1], [int]$p[2]) }
      'd' { $f = @{ l = 0x2; r = 0x8; m = 0x20 }[$p[1]]; [LmInput]::mouse_event($f, 0, 0, 0, [UIntPtr]::Zero) }
      'u' { $f = @{ l = 0x4; r = 0x10; m = 0x40 }[$p[1]]; [LmInput]::mouse_event($f, 0, 0, 0, [UIntPtr]::Zero) }
      'w' { [LmInput]::mouse_event(0x800, 0, 0, [int]$p[1], [UIntPtr]::Zero) }
      'k' {
        $vk = [byte][int]$p[1]
        $flags = 0
        if ($p[2] -eq '0') { $flags = $flags -bor 0x2 }
        if ($p[3] -eq '1') { $flags = $flags -bor 0x1 }
        $scan = [byte][LmInput]::MapVirtualKey($vk, 0)
        [LmInput]::keybd_event($vk, $scan, $flags, [UIntPtr]::Zero)
      }
    }
  } catch { }
}
`;

// Browser key codes (KeyboardEvent.code) -> Windows virtual-key codes; the
// last flag marks "extended" keys (arrows, Insert/Delete block, right Ctrl/Alt…).
const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, NumpadEnter: [0x0D, 1], ShiftLeft: 0xA0, ShiftRight: 0xA1,
  ControlLeft: 0xA2, ControlRight: [0xA3, 1], AltLeft: 0xA4, AltRight: [0xA5, 1], Pause: 0x13, CapsLock: 0x14,
  Escape: 0x1B, Space: 0x20, PageUp: [0x21, 1], PageDown: [0x22, 1], End: [0x23, 1], Home: [0x24, 1],
  ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1], PrintScreen: [0x2C, 1],
  Insert: [0x2D, 1], Delete: [0x2E, 1], MetaLeft: [0x5B, 1], MetaRight: [0x5C, 1], ContextMenu: [0x5D, 1],
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadDecimal: 0x6E, NumpadDivide: [0x6F, 1],
  NumLock: [0x90, 1], ScrollLock: 0x91, Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE,
  Slash: 0xBF, Backquote: 0xC0, BracketLeft: 0xDB, Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE, IntlBackslash: 0xE2,
};
for (let i = 0; i < 26; i++) VK[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
for (let i = 0; i < 10; i++) { VK[`Digit${i}`] = 0x30 + i; VK[`Numpad${i}`] = 0x60 + i; }
for (let i = 1; i <= 24; i++) VK[`F${i}`] = 0x6F + i;

function vkFor(code) {
  const v = VK[code];
  if (v === undefined) return null;
  return Array.isArray(v) ? { vk: v[0], ext: v[1] } : { vk: v, ext: 0 };
}

class RemoteInput {
  constructor({ log, onFail } = {}) {
    this.onFail = onFail || null;
    this.proc = null;
    this.ready = false;
    this.queue = [];
    this.down = new Set(); // keys and buttons held, released when control ends
    this.log = log || null; // tests: record commands instead of running them
  }

  static supported() {
    return process.platform === 'win32' || !!process.env.LANMSG_INPUT_LOG;
  }

  start() {
    if (this.proc || this.log) { this.ready = true; return; }
    if (process.platform !== 'win32') throw new Error('Remote control works on Windows only');
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout.on('data', (d) => {
      if (!this.ready && /ready/.test(String(d))) {
        this.ready = true;
        for (const line of this.queue.splice(0)) this._write(line);
      }
    });
    this.proc.on('exit', () => {
      const failed = this.proc && !this.stopping;
      this.proc = null;
      this.ready = false;
      if (failed && this.onFail) this.onFail();
    });
    this.proc.on('error', () => { if (this.onFail && !this.stopping) this.onFail(); });
    this.proc.stdin.on('error', () => {});
  }

  _write(line) {
    if (this.log) { this.log.push(line); return; }
    if (!this.proc) return;
    if (!this.ready) { if (this.queue.length < 500) this.queue.push(line); return; }
    this.proc.stdin.write(`${line}\n`);
  }

  move(x, y) { this._write(`m ${Math.round(x)} ${Math.round(y)}`); }

  button(b, down) {
    const k = { 0: 'l', 1: 'm', 2: 'r' }[b];
    if (!k) return;
    const id = `b${k}`;
    if (down) this.down.add(id); else this.down.delete(id);
    this._write(`${down ? 'd' : 'u'} ${k}`);
  }

  wheel(deltaY) {
    const n = Math.max(-2400, Math.min(2400, Math.round(-deltaY / 100) * 120 || -Math.sign(deltaY) * 120));
    this._write(`w ${n}`);
  }

  key(code, down) {
    const k = vkFor(code);
    if (!k) return;
    const id = `k${code}`;
    if (down) this.down.add(id); else this.down.delete(id);
    this._write(`k ${k.vk} ${down ? 1 : 0} ${k.ext}`);
  }

  // Lets go of everything still held, then closes the helper.
  stop() {
    for (const id of [...this.down]) {
      if (id[0] === 'b') this._write(`u ${id[1]}`);
      else { const k = vkFor(id.slice(1)); if (k) this._write(`k ${k.vk} 0 ${k.ext}`); }
    }
    this.down.clear();
    this.stopping = true;
    if (this.proc) {
      const p = this.proc;
      setTimeout(() => { try { p.stdin.end(); p.kill(); } catch { /* gone */ } }, 300);
    }
    this.proc = null;
    this.ready = false;
  }
}

module.exports = { RemoteInput, vkFor, SCRIPT };
