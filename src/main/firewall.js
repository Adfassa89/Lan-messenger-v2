'use strict';
// Windows Firewall: can other PCs connect to this one, and a way to allow it.
// Settings shows the result. Allowing needs administrator rights, so Windows
// asks for permission (or an administrator's password).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const RULE = 'LAN Messenger 2';

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Asks Windows (language-independent PowerShell objects, effective rules
// including company policy) about the rules that matter for this app.
// Prints: profilesOn,allowRules,blockRules
function checkScript(exe, tcp, udp) {
  return `$ErrorActionPreference = 'SilentlyContinue'
$exe = ${psQuote(exe)}
$on = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { $_.Enabled -eq 'True' }).Count
$apps = @(Get-NetFirewallApplicationFilter -All -PolicyStore ActiveStore | Where-Object { $_.Program -ieq $exe } | ForEach-Object { $_.InstanceID })
$ports = @(Get-NetFirewallPortFilter -All -PolicyStore ActiveStore | Where-Object {
  ($_.Protocol -eq 'TCP' -and @($_.LocalPort) -contains '${tcp}') -or ($_.Protocol -eq 'UDP' -and @($_.LocalPort) -contains '${udp}') } | ForEach-Object { $_.InstanceID })
$ids = $apps + $ports
$rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -PolicyStore ActiveStore | Where-Object { $ids -contains $_.InstanceID })
$allow = @($rules | Where-Object { $_.Action -eq 'Allow' }).Count
$block = @($rules | Where-Object { $_.Action -eq 'Block' -and $apps -contains $_.InstanceID }).Count
Write-Output "$on,$allow,$block"`;
}

// "on,allow,block" -> what Settings shows.
function parseCheck(out) {
  const m = /(\d+),(\d+),(\d+)/.exec(out || '');
  if (!m) return 'unknown';
  const [on, allow, block] = m.slice(1).map(Number);
  if (on === 0) return 'off';
  if (block > 0) return 'blocked';
  if (allow > 0) return 'ok';
  return 'missing';
}

// Removes old rules for this program (Windows adds "block" rules when its
// first-launch question is cancelled) and allows the program and its ports.
// The port rules also cover the portable version, which runs from a
// temporary folder.
function allowScript(exe, tcp, udp) {
  const q = (s) => `"${s}"`;
  return [
    '@echo off',
    `netsh advfirewall firewall delete rule name=all program=${q(exe)} >nul`,
    `netsh advfirewall firewall delete rule name=${q(RULE)} >nul`,
    `netsh advfirewall firewall delete rule name=${q(`${RULE} (TCP ${tcp})`)} >nul`,
    `netsh advfirewall firewall delete rule name=${q(`${RULE} (UDP ${udp})`)} >nul`,
    `netsh advfirewall firewall add rule name=${q(RULE)} dir=in action=allow program=${q(exe)} enable=yes profile=any`,
    `netsh advfirewall firewall add rule name=${q(`${RULE} (TCP ${tcp})`)} dir=in action=allow protocol=TCP localport=${tcp} enable=yes profile=any`,
    `netsh advfirewall firewall add rule name=${q(`${RULE} (UDP ${udp})`)} dir=in action=allow protocol=UDP localport=${udp} enable=yes profile=any`,
    '',
  ].join('\r\n');
}

class Firewall {
  constructor({ exe, ports }) {
    this.exe = exe;
    this.ports = ports; // () => { tcp, udp }
    this.last = null;
  }

  async check() {
    if (process.platform !== 'win32') return { state: 'na' };
    const { tcp, udp } = this.ports();
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', checkScript(this.exe, tcp, udp)]);
    this.last = { state: parseCheck(r.out), at: Date.now() };
    return this.last;
  }

  // Runs the rules with administrator rights (Windows asks first).
  async allow() {
    if (process.platform !== 'win32') return { state: 'na' };
    const { tcp, udp } = this.ports();
    const file = path.join(os.tmpdir(), `lanmsg-firewall-${process.pid}.cmd`);
    fs.writeFileSync(file, allowScript(this.exe, tcp, udp));
    try {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath ${psQuote(file)} -Verb RunAs -WindowStyle Hidden -Wait`], 120000);
      if (!r.ok) return { state: 'cancelled' };
    } finally {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
    return this.check();
  }
}

module.exports = { Firewall, parseCheck, allowScript, checkScript };
