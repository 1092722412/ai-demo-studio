import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type CredentialStore = {
  put(ref: string, secret: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
};

export const credentialStore: CredentialStore = {
  async put(ref, secret) { await run('Write', ref, secret); },
  async get(ref) {
    const value = await run('Read', ref);
    return value ? new TextDecoder('utf-16le', { ignoreBOM: true }).decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0))) : null;
  },
  async delete(ref) { await run('Delete', ref); },
};

export function createCredentialService(store: CredentialStore) {
  return {
    async save<T>(connectionId: string, oldRef: string | null, secret: string | null, commit: (ref: string | null) => T): Promise<T> {
      const ref = secret === null ? null : 'ai-demo-studio:' + connectionId + ':' + randomUUID();
      if (ref && secret !== null) await store.put(ref, secret);
      let saved: T;
      try {
        saved = commit(ref);
      } catch (error) {
        if (ref) await store.delete(ref);
        throw error;
      }
      if (oldRef) await store.delete(oldRef);
      return saved;
    },
    async read(ref: string | null) { return ref ? store.get(ref) : null; },
  };
}

async function run(operation: 'Write' | 'Read' | 'Delete', ref: string, secret = ''): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Windows 凭据管理器仅在 Windows 上可用。');
  const argumentsText = operation === 'Write' ? '$env:STUDIO_CREDENTIAL_REF, [Console]::In.ReadToEnd()' : '$env:STUDIO_CREDENTIAL_REF';
  const script = "$ErrorActionPreference = 'Stop'\n[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n"
    + credentialType + '\n[StudioCredential]::' + operation + '(' + argumentsText + ')';
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 10_000, env: { ...process.env, STUDIO_CREDENTIAL_REF: ref },
    }, (error, stdout) => {
      if (error) reject(new Error('Windows 凭据管理器操作失败。'));
      else resolve(stdout.trim());
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(secret));
  });
}

// 通过系统 API 操作当前用户的通用凭据。密钥经标准输入传递。
const credentialType = "Add-Type -TypeDefinition @'\n"
+ [
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class StudioCredential {',
  ' [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CRED {',
  '   public uint Flags, Type; public string TargetName, Comment;',
  '   public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '   public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist, AttributeCount;',
  '   public IntPtr Attributes; public string TargetAlias, UserName;',
  ' }',
  ' [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CRED c, uint flags);',
  ' [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);',
  ' [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDelete(string target, uint type, uint flags);',
  ' [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr cred);',
  ' public static void Write(string target, string secret) {',
  '   var bytes = Encoding.Unicode.GetBytes(secret);',
  '   var p = Marshal.AllocHGlobal(bytes.Length);',
  '   try {',
  '     Marshal.Copy(bytes, 0, p, bytes.Length);',
  '     var c = new CRED { Type=1,TargetName=target,CredentialBlob=p,CredentialBlobSize=(uint)bytes.Length,Persist=2,UserName="AI Demo Studio" };',
  '     if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
  '   } finally { Marshal.FreeHGlobal(p); }',
  ' }',
  ' public static string Read(string target) {',
  '   IntPtr p;',
  '   if (!CredRead(target, 1, 0, out p)) { MissingOrThrow(); return null; }',
  '   try {',
  '     var c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));',
  '     var bytes = new byte[c.CredentialBlobSize];',
  '     Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);',
  '     return Convert.ToBase64String(bytes);',
  '   } finally { CredFree(p); }',
  ' }',
  ' public static void Delete(string target) { if (!CredDelete(target, 1, 0)) MissingOrThrow(); }',
  ' static void MissingOrThrow() { int code = Marshal.GetLastWin32Error(); if (code != 1168) throw new System.ComponentModel.Win32Exception(code); }',
  '}',
].join('\n') + "\n'@";
