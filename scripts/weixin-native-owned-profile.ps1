# 仅自有TEMP组件协议，不发现KnownFolder、不接实际app/生产root。
param([string]$Mode, [string]$FixtureRoot, [string]$Nonce)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
if ($Mode -cne 'own-temp-component' -or $Nonce -cnotmatch '^[a-f0-9]{32}$' -or ![Environment]::Is64BitProcess) { throw 'component mode/ABI rejected' }
$FixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
if ($FixtureRoot.TrimEnd('\') -ine $temp -or [IO.Path]::GetFileName($FixtureRoot) -cnotmatch '^weixin-owned-profile-fixture-[A-Za-z0-9]+$') { throw 'not own TEMP fixture' }
$r = Get-Content -LiteralPath (Join-Path $FixtureRoot '.fixture-receipt.json') -Raw | ConvertFrom-Json
if ($r.schemaVersion -ne 1 -or $r.scope -cne 'own-temp-component-only' -or $r.nonce -cne $Nonce -or $r.creatorPid -le 0) { throw 'fixture receipt rejected' }

# 原子FILE_CREATE返回held目录handle；没有CreateDirectory后Open的空窗。
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class OwnedProfileFixtureCore : IDisposable {
  const uint READ=0x80, LIST=1, DELETE=0x10000, SYNC=0x100000;
  const uint SHARE_READ_WRITE=3, OPEN_EXISTING=3, BACKUP=0x02000000, REPARSE=0x00200000;
  const uint OBJ_CASE_INSENSITIVE=0x40, OBJ_DONT_REPARSE=0x1000;
  const string Leaf="ai.openclaw.clawpanel";
  [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Flags; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string n,uint a,uint s,IntPtr sa,uint c,uint f,IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint n,uint f);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributesW(string p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int c,IntPtr p,uint n);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle h,uint access,ref Attributes a,out IoStatus io,IntPtr size,uint attributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  sealed class Held { public SafeFileHandle Handle; public string Identity, Path; }
  sealed class Parent { public List<Held> Chain; public Held Directory; }
  readonly string root;
  readonly Dictionary<string,Parent> parents=new Dictionary<string,Parent>();
  readonly Dictionary<string,Held> leases=new Dictionary<string,Held>();
  int opens, closes;
  public OwnedProfileFixtureCore(string fixtureRoot) { root=Path.GetFullPath(fixtureRoot).TrimEnd('\\'); }
  public int OpenHandles { get { return opens-closes; } }
  public int Opens { get { return opens; } }
  public int Closes { get { return closes; } }
  void Close(SafeFileHandle h) { if(h!=null && !h.IsInvalid && !h.IsClosed){h.Dispose();closes++;} }
  static Exception Win(string operation) { return new IOException(operation+" win32="+Marshal.GetLastWin32Error()); }
  static Dictionary<string,object> Result(params object[] pairs) { var r=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)r.Add((string)pairs[i],pairs[i+1]);return r; }
  Held Read(SafeFileHandle h) {
    Info i;if(!GetFileInformationByHandle(h,out i))throw Win("identity");
    if((i.Attributes&0x10)==0 || (i.Attributes&0x400)!=0)throw new IOException("non-directory/reparse rejected");
    var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);
    if(n==0 || n>=b.Capacity)throw Win("canonical path");
    string p=b.ToString();if(p.StartsWith("\\\\?\\"))p=p.Substring(4);
    return new Held { Handle=h,Identity=i.Volume.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8"),Path=p.TrimEnd('\\') };
  }
  void Verify(Held expected) {
    if(expected==null || expected.Handle.IsClosed || expected.Handle.IsInvalid)throw new IOException("unknown held handle");
    Held actual=Read(expected.Handle);
    if(actual.Identity!=expected.Identity || !String.Equals(actual.Path,expected.Path,StringComparison.OrdinalIgnoreCase))throw new IOException("held identity contradiction");
  }
  public object OpenParent(string relative) {
    if(String.IsNullOrEmpty(relative) || !System.Text.RegularExpressions.Regex.IsMatch(relative,"^case-[a-z0-9-]+$"))throw new IOException("exact fixture parent only");
    string target=Path.Combine(root,relative), volume=Path.GetPathRoot(target);
    if(volume==null || volume.StartsWith("\\\\"))throw new IOException("local volume only");
    var chain=new List<Held>();
    try {
      string current=volume;
      var names=new List<string>();names.Add(volume);string rest=target.Substring(volume.Length);
      foreach(string part in rest.Split('\\')) { if(part.Length==0)throw new IOException("empty component");current=Path.Combine(current,part);names.Add(current); }
      foreach(string name in names) {
        SafeFileHandle h=CreateFileW(name,READ|LIST|SYNC,SHARE_READ_WRITE,IntPtr.Zero,OPEN_EXISTING,BACKUP|REPARSE,IntPtr.Zero);
        if(h.IsInvalid){h.Dispose();throw Win("parent open");}opens++;
        try { Held got=Read(h);if(!String.Equals(got.Path,Path.GetFullPath(name).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("parent alias rejected");chain.Add(got); }
        catch { Close(h);throw; }
      }
      string ticket=Guid.NewGuid().ToString("N");Held last=chain[chain.Count-1];
      parents.Add(ticket,new Parent { Chain=chain,Directory=last });
      return Result("ticket",ticket,"identity",last.Identity,"path",last.Path);
    }catch{foreach(Held h in chain)Close(h.Handle);throw;}
  }
  public object Create(string ticket,string parentIdentity,string leaf) {
    Parent p;if(ticket==null || !parents.TryGetValue(ticket,out p) || p.Directory.Identity!=parentIdentity || leaf!=Leaf)throw new IOException("parent/leaf contract rejected");
    foreach(Held h in p.Chain)Verify(h);
    IntPtr text=IntPtr.Zero, unicode=IntPtr.Zero;SafeFileHandle owned=null;
    try {
      text=Marshal.StringToHGlobalUni(leaf);var u=new Unicode {Length=checked((ushort)(leaf.Length*2)),MaximumLength=checked((ushort)(leaf.Length*2+2)),Buffer=text};
      unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode)));Marshal.StructureToPtr(u,unicode,false);
      // 同一次相对held父目录的创建禁止重解析；拒绝dangling junction时也绝不先创建target。
      var a=new Attributes {Length=Marshal.SizeOf(typeof(Attributes)),RootDirectory=p.Directory.Handle.DangerousGetHandle(),ObjectName=unicode,Flags=OBJ_CASE_INSENSITIVE|OBJ_DONT_REPARSE};
      IoStatus io;int status=NtCreateFile(out owned,READ|LIST|DELETE|SYNC,ref a,out io,IntPtr.Zero,0,SHARE_READ_WRITE,2,0x1|0x20,IntPtr.Zero,0);
      // FILE_CREATE=2、FILE_DIRECTORY_FILE=1、FILE_SYNCHRONOUS_IO_NONALERT=0x20；仅FILE_CREATED=2。
      if(owned!=null && !owned.IsInvalid)opens++;
      if(status!=0 || owned==null || owned.IsInvalid || io.Information.ToUInt64()!=2)throw new IOException("NtCreateFile status=0x"+unchecked((uint)status).ToString("x8")+" information="+io.Information.ToUInt64());
      Held h=Read(owned);string expected=Path.Combine(p.Directory.Path,Leaf);
      if(!String.Equals(h.Path,expected,StringComparison.OrdinalIgnoreCase))throw new IOException("created path contradiction");
      string lease=Guid.NewGuid().ToString("N");leases.Add(lease,h);owned=null;
      return Result("lease",lease,"identity",h.Identity,"path",h.Path,"created",true,"information","FILE_CREATED","informationNumber",2,"nativeStatus","0x00000000","held",true,"parentIdentity",p.Directory.Identity);
    }finally{Close(owned);if(unicode!=IntPtr.Zero)Marshal.FreeHGlobal(unicode);if(text!=IntPtr.Zero)Marshal.FreeHGlobal(text);}
  }
  public object Release(string lease,string identity) {
    Held h;if(lease==null || !leases.TryGetValue(lease,out h) || String.IsNullOrEmpty(identity) || h.Identity!=identity)throw new IOException("unknown/contradictory release identity");
    Verify(h);
    // 内核在同一held handle上检查empty；非空返回ERROR_DIR_NOT_EMPTY，绝无递归删除。
    IntPtr disposition=Marshal.AllocHGlobal(1);
    try {Marshal.WriteByte(disposition,1);if(!SetFileInformationByHandle(h.Handle,4,disposition,1))throw Win("empty held release");}
    finally{Marshal.FreeHGlobal(disposition);}
    Close(h.Handle);leases.Remove(lease);
    uint attributes=GetFileAttributesW(h.Path);int error=Marshal.GetLastWin32Error();
    if(attributes!=0xffffffff || (error!=2 && error!=3))throw new IOException("release absence not proved error="+error);
    return Result("releasedByHeldHandle",true,"identity",identity,"absent",true);
  }
  public void Dispose() {
    foreach(Held h in leases.Values)Close(h.Handle);leases.Clear();
    foreach(Parent p in parents.Values)foreach(Held h in p.Chain)Close(h.Handle);parents.Clear();
  }
}
'@

$core = New-Object OwnedProfileFixtureCore($FixtureRoot)
try {
  $count=0; $total=0
  while ($null -ne ($line=[Console]::ReadLine())) {
    $count++; $total += [Text.Encoding]::UTF8.GetByteCount($line)
    if ($count -gt 128 -or $line.Length -gt 24576 -or $total -gt 16MB) { throw 'component protocol budget exceeded' }
    $q=$line | ConvertFrom-Json; $response=@{id=$q.id;ok=$false}
    try {
      if ($q.id -lt 1 -or $q.id -ne $count) { throw 'ordered request id required' }
      switch -CaseSensitive ($q.op) {
        'parent' { $value=$core.OpenParent([string]$q.relative) }
        'create' { $value=$core.Create([string]$q.parent,[string]$q.parentIdentity,[string]$q.leaf) }
        'release' { $value=$core.Release([string]$q.lease,[string]$q.identity) }
        'shutdown' { $core.Dispose();$value=@{openHandles=$core.OpenHandles;opens=$core.Opens;closes=$core.Closes;componentTempActual=$temp} }
        default { throw 'component operation rejected' }
      }
      foreach($key in $value.Keys){$response[$key]=$value[$key]};$response.ok=$true
    } catch { $response.error=$_.Exception.Message }
    [Console]::WriteLine(($response | ConvertTo-Json -Depth 8 -Compress))
    if ($q.op -ceq 'shutdown') { break }
  }
} finally { $core.Dispose() }
