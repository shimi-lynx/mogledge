[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProviderRoot,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [ValidateSet('Read', 'ReadWrite')][string]$ParentSharing = 'Read',
    [switch]$ConfirmDisposableFixture
)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmDisposableFixture) {
    throw 'Explicit approval for a fresh disposable provider fixture is required.'
}
# Exact path metadata only; never enumerate a synchronized source directory.
if ($ProviderRoot -notmatch '^[A-Za-z]:\\' -or $ProviderRoot -match '[\x00*?/]' -or
    @($ProviderRoot.Substring(3).Split('\') | Where-Object { $_ -in '.', '..' -or $_.Contains(':') }).Count) {
    throw 'An absolute local provider directory without aliases or wildcard syntax is required.'
}
[IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class OneDriveWriterProbe {
 [StructLayout(LayoutKind.Sequential)] struct TagInfo { public uint Attributes; public uint Tag; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FindData {
  public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,SizeHigh,SizeLow,Tag,Reserved;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string AlternateName;
 }
 [StructLayout(LayoutKind.Sequential)] struct IdInfo { public ulong Volume; public ulong Low; public ulong High; }
 [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public uint Length; public IntPtr Root; public IntPtr Name; public uint Attributes; public IntPtr Security; public IntPtr Quality; }
 [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int cls,out TagInfo info,uint size);
 [DllImport("kernel32.dll",SetLastError=true,EntryPoint="GetFileInformationByHandleEx")] static extern bool GetId(SafeFileHandle handle,int cls,out IdInfo info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle handle,byte[] bytes,uint length,out uint written,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFileW(string path,out FindData info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr search);
 [DllImport("ntdll.dll")] static extern sbyte RtlSetThreadPlaceholderCompatibilityMode(sbyte mode);
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle,uint access,ref ObjectAttributes attributes,out IoStatus status,IntPtr allocation,uint fileAttributes,uint sharing,uint disposition,uint options,IntPtr ea,uint eaLength);
 [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle,out IoStatus status,IntPtr information,uint length,uint cls);
 [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
 [DllImport("cldapi.dll")] static extern uint CfGetPlaceholderStateFromAttributeTag(uint attributes,uint tag);
 static readonly List<string> Events = new List<string>();
 static string Id(SafeFileHandle handle) { IdInfo id; if(!GetId(handle,18,out id,24)) throw new Win32Exception(Marshal.GetLastWin32Error()); return id.Volume.ToString("x")+":"+id.Low.ToString("x16")+id.High.ToString("x16"); }
 static string Metadata(SafeFileHandle handle,bool requireResident) {
  TagInfo info; if(!GetFileInformationByHandleEx(handle,9,out info,8)) throw new Win32Exception(Marshal.GetLastWin32Error());
  bool supported=(info.Attributes&0x400)==0 || (info.Tag&~0xf000u)==0x9000001a;
  uint state=CfGetPlaceholderStateFromAttributeTag(info.Attributes,info.Tag);
  if(requireResident && (!supported || (info.Attributes&0x401000)!=0 || state==uint.MaxValue || (state&0x30)!=0)) throw new IOException("unsupported/unavailable metadata");
  return "attrs="+info.Attributes.ToString("x8")+" tag="+info.Tag.ToString("x8")+" state="+state.ToString("x8");
 }
 static uint ParentSharing;
 static void InspectNamedEntry(string path) {
  string query=Path.TrimEndingDirectorySeparator(path);
  if(Path.GetFileName(query).Length==0) return;
  FindData entry; IntPtr search=FindFirstFileW(query,out entry);
  if(search==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
  try {
   // RECALL_ON_OPEN is meaningful only in exposed enumeration metadata; in
   // handle metadata its bit aliases EA. Query only this exact known entry.
   if((entry.Attributes&0x441000)!=0 || ((entry.Attributes&0x400)!=0 && (entry.Tag&~0xf000u)!=0x9000001a)) throw new IOException("named entry requires recall or is unsupported");
  } finally {if(!FindClose(search)) throw new Win32Exception(Marshal.GetLastWin32Error());}
 }
 static SafeFileHandle OpenDirectory(string path) {
  // Attribute-only no-follow preflight precedes list access. The caller already
  // holds every earlier ancestor; never acquire contents to repair availability.
  using(var metadata=CreateFileW(path,0x80,3,IntPtr.Zero,3,0x02300000,IntPtr.Zero)) {
   if(metadata.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
   Metadata(metadata,true); InspectNamedEntry(path); string expectedId=Id(metadata);
  var handle=CreateFileW(path,0x81,ParentSharing,IntPtr.Zero,3,0x02300000,IntPtr.Zero);
  if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
  try {
  if(Id(handle)!=expectedId) throw new IOException("directory changed before list access");
  Metadata(handle,true); return handle;
  } catch {handle.Dispose();throw;}
  }
 }
 static SafeFileHandle CreateLeaf(SafeFileHandle parent,string leaf,bool directory,uint access,bool expectCollision) {
  if(leaf.IndexOfAny(new[]{'\\','/',':','\0'})>=0 || leaf=="." || leaf=="..") throw new ArgumentException("single leaf required");
  Metadata(parent,true);
  IntPtr text=Marshal.StringToHGlobalUni(leaf); IntPtr name=IntPtr.Zero;
  try {
   var unicode=new UnicodeString{Length=checked((ushort)(leaf.Length*2)),MaximumLength=checked((ushort)(leaf.Length*2)),Buffer=text};
   name=Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>()); Marshal.StructureToPtr(unicode,name,false);
   var attributes=new ObjectAttributes{Length=(uint)Marshal.SizeOf<ObjectAttributes>(),Root=parent.DangerousGetHandle(),Name=name,Attributes=0x40};
   IoStatus io; IntPtr raw;
   var clock=Stopwatch.StartNew();
   int status=NtCreateFile(out raw,access,ref attributes,out io,IntPtr.Zero,0x80,3,2,0x00200000|0x20u|(directory?1u:0x40u),IntPtr.Zero,0);
   Events.Add("create "+leaf+" status="+unchecked((uint)status).ToString("x8")+" info="+io.Information.ToUInt64()+" ms="+clock.ElapsedMilliseconds);
   if(status<0) {
    if(expectCollision && RtlNtStatusToDosError(status)==183) return null;
    throw new Win32Exception((int)RtlNtStatusToDosError(status));
   }
   var child=new SafeFileHandle(raw,true);
   try {
   if(expectCollision || status!=0 || io.Information.ToUInt64()!=2) throw new IOException("unexpected create completion; preserve fixture");
   Metadata(child,true); return child;
   } catch {child.Dispose();throw;}
  } finally { if(name!=IntPtr.Zero) Marshal.FreeHGlobal(name); Marshal.FreeHGlobal(text); }
 }
 static void Rename(SafeFileHandle child,SafeFileHandle target,string leaf) {
  Metadata(child,true); Metadata(target,true);
  // FILE_RENAME_INFORMATION carries a held target handle and a single leaf;
  // ReplaceIfExists remains false. Its tail starts after the native pointer.
  byte[] name=Encoding.Unicode.GetBytes(leaf); int offset=IntPtr.Size==8?20:12; int size=offset+name.Length;
  IntPtr info=Marshal.AllocHGlobal(size);
  try {
   for(int i=0;i<size;i++) Marshal.WriteByte(info,i,0);
   Marshal.WriteIntPtr(info,IntPtr.Size==8?8:4,target.DangerousGetHandle());
   Marshal.WriteInt32(info,IntPtr.Size==8?16:8,name.Length); Marshal.Copy(name,0,IntPtr.Add(info,offset),name.Length);
   IoStatus io; var clock=Stopwatch.StartNew(); int result=NtSetInformationFile(child,out io,info,(uint)size,10);
   Events.Add("rename "+leaf+" status="+unchecked((uint)result).ToString("x8")+" ms="+clock.ElapsedMilliseconds);
   if(result!=0) throw new Win32Exception((int)RtlNtStatusToDosError(result));
   Metadata(child,true); Metadata(target,true);
  } finally {Marshal.FreeHGlobal(info);}
 }
 public static string[] Run(string root,string fixtureName,uint parentSharing) {
  if(!fixtureName.StartsWith("Mogledge-OneDrive-QA-",StringComparison.Ordinal) || !Guid.TryParse(fixtureName.Substring(21),out _)) throw new ArgumentException("fresh QA fixture required");
  sbyte previous=RtlSetThreadPlaceholderCompatibilityMode(2); if(previous<0) throw new IOException("placeholder visibility unavailable");
  ParentSharing=parentSharing;
  var ancestors=new List<SafeFileHandle>();
  try {
   var paths=new List<string>(); string path=root; while(path!=null){paths.Add(path);path=Directory.GetParent(path)?.FullName;} paths.Reverse();
   foreach(string ancestor in paths) ancestors.Add(OpenDirectory(ancestor));
   SafeFileHandle parent=ancestors[ancestors.Count-1]; string rootId=Id(parent);
   TagInfo rootInfo;
   if(!GetFileInformationByHandleEx(parent,9,out rootInfo,8) || (rootInfo.Attributes&0x410)!=0x410 || (rootInfo.Tag&~0xf000u)!=0x9000001a) throw new IOException("a resident documented Cloud Files directory is required");
   Events.Add("root before "+Metadata(parent,true)+" identity="+rootId);
   using(var fixture=CreateLeaf(parent,fixtureName,true,0x1000a1,false)) {
    string fixtureId=Id(fixture); Events.Add("fixture before "+Metadata(fixture,true)+" identity="+fixtureId);
    using(var deleteAttempt=CreateFileW(Path.Combine(root,fixtureName),0x10000,7,IntPtr.Zero,3,0x02300000,IntPtr.Zero)) {
     int error=Marshal.GetLastWin32Error(); Events.Add("fixture delete-access blocked="+deleteAttempt.IsInvalid+" error="+error);
     if(!deleteAttempt.IsInvalid || error!=32) throw new IOException("no-delete protection not established");
    }
    using(var target=CreateLeaf(fixture,"target",true,0x1000a1,false)) {
     using(var child=CreateLeaf(fixture,"folder-before",true,0x1100a1,false)) {
      string childId=Id(child); CreateLeaf(fixture,"folder-before",true,0x1000a1,true);
      Rename(child,fixture,"folder-renamed"); Rename(child,target,"folder-moved");
      if(Id(child)!=childId) throw new IOException("folder identity changed");
      Events.Add("folder move identity preserved");
     }
     using(var reopened=OpenDirectory(Path.Combine(root,fixtureName,"target","folder-moved"))) Events.Add("folder reopen "+Metadata(reopened,true));
     string htmlId;
     using(var file=CreateLeaf(fixture,"probe-before.html",false,0x110083,false)) {
      htmlId=Id(file); byte[] bytes=Encoding.UTF8.GetBytes("<!doctype html><title>Disposable OneDrive QA 072</title><p>Synthetic fixture only</p>"); uint written;
      if(!WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero) || written!=bytes.Length || !FlushFileBuffers(file)) throw new Win32Exception(Marshal.GetLastWin32Error());
      Rename(file,fixture,"probe-renamed.html"); Rename(file,target,"probe-moved.html");
      if(Id(file)!=htmlId) throw new IOException("file identity changed");
     }
     using(var reopened=CreateFileW(Path.Combine(root,fixtureName,"target","probe-moved.html"),0x81,1,IntPtr.Zero,3,0x00300000,IntPtr.Zero)) {
      if(reopened.IsInvalid || Id(reopened)!=htmlId) throw new IOException("file reopen identity mismatch");
      Events.Add("html reopen "+Metadata(reopened,true)+" identity preserved");
     }
    }
    if(Id(fixture)!=fixtureId) throw new IOException("fixture identity changed"); Events.Add("fixture after "+Metadata(fixture,true));
   }
   if(Id(parent)!=rootId) throw new IOException("root identity changed"); Events.Add("root after "+Metadata(parent,true)+" identity preserved");
   Events.Add("No wildcard listing, content recall request, settings change or cleanup performed; provider callbacks unobserved.");
   return Events.ToArray();
  } catch(Exception error) {Events.Add("STOP "+error.GetType().Name+": "+error.Message);return Events.ToArray();}
  finally {foreach(var handle in ancestors) handle.Dispose();RtlSetThreadPlaceholderCompatibilityMode(previous);}
 }
}
"@
$fixtureName = 'Mogledge-OneDrive-QA-' + [guid]::NewGuid().ToString()
$sharing = if ($ParentSharing -eq 'Read') { 1 } else { 3 }
$events = [OneDriveWriterProbe]::Run($ProviderRoot, $fixtureName, $sharing)
$sourceSha = git -C (Split-Path -Parent $PSScriptRoot) rev-parse HEAD
$record = [ordered]@{
    source = $sourceSha
    scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
    fixturePath = Join-Path $ProviderRoot $fixtureName
    parentSharing = $ParentSharing
    windows = [Environment]::OSVersion.VersionString
    utc = [DateTime]::UtcNow.ToString('o')
    events = $events
}
$record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'result.private.json') -Encoding UTF8
$events
if ($events -match '^STOP ') { exit 1 }
