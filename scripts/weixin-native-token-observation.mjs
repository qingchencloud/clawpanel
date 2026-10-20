// 仅显式诊断的只读process-primary-token观察；不复制、修改、模拟或以token启动进程。
import assert from 'node:assert/strict'
import path from 'node:path'

export function sameCimMicrosecond(cim, file) {
  for (const v of [cim, file]) assert.ok(typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v), 'FILETIME须保留十进制原值')
  const c = BigInt(cim), f = BigInt(file)
  return c % 10n === 0n && f >= c && f - c <= 9n
}
const PS_PREFIX = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n"
export function tokenEncodedCommandLength(source) {
  // Windows CreateProcess上限含可执行路径/空格/引号/NUL；使用保守固定余量，不扩大32767。
  const n = Buffer.from(PS_PREFIX + source, 'utf16le').toString('base64').length + 512
  assert.ok(n < 32767, 'token PS命令行超过32767'); return n
}
function validateRequest(r) {
  const keys = (o, names) => { assert.ok(o && typeof o === 'object' && !Array.isArray(o)); assert.deepEqual(Object.keys(o).sort(), names.sort()) }
  keys(r, ['app', 'parent', 'expectedSid']); keys(r.app, ['pid', 'exe', 'startedAt', 'returnedAt']); keys(r.parent, ['pid', 'exe'])
  for (const p of [r.app, r.parent]) { assert.ok(Number.isSafeInteger(p.pid) && p.pid > 0 && p.pid <= 0xffffffff); assert.ok(typeof p.exe === 'string' && /^[a-z]:\\/i.test(p.exe) && path.win32.normalize(p.exe) === p.exe && !p.exe.includes('\0')) }
  assert.notEqual(r.app.pid, r.parent.pid)
  assert.ok(Number.isSafeInteger(r.app.startedAt) && r.app.startedAt >= 0 && Number.isSafeInteger(r.app.returnedAt) && r.app.returnedAt >= r.app.startedAt)
  assert.match(r.expectedSid, /^S-1-5-21-\d+-\d+-\d+-\d+$/)
}
export function publicTokenObservation(proof, request) {
  validateRequest(request)
  const keys = (o, names) => { assert.ok(o && typeof o === 'object' && !Array.isArray(o)); assert.deepEqual(Object.keys(o).sort(), names.sort(), 'token proof白名单不符') }
  keys(proof, ['mode', 'neverQualification', 'app', 'parent'])
  assert.equal(proof.mode, 'readonly-win32-process-primary-token'); assert.equal(proof.neverQualification, true)
  const utcTicks = text => {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{7})Z$/.exec(text); assert.ok(m, 'token出生缺原始100ns UTC值')
    const ms = Date.parse(m[1] + 'Z'); assert.ok(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === m[1])
    return BigInt(ms) * 10000n + 116444736000000000n + BigInt(m[2])
  }
  const fields = ['pid', 'parentPid', 'exe', 'cimCreationUtc', 'fileTimeCreationUtc', 'cimFileTimeTicks', 'fileTimeTicks', 'delta100ns', 'birthComparison', 'userSid', 'integritySid', 'integrityRid', 'isElevated', 'elevationType', 'tokenType', 'sessionId', 'uiAccess', 'linked']
  for (const role of ['app', 'parent']) {
    const p = proof[role], expected = request[role]; keys(p, [...fields])
    assert.equal(p.pid, expected.pid); assert.equal(p.exe.toLowerCase(), expected.exe.toLowerCase()); assert.equal(p.userSid, request.expectedSid)
    assert.ok(sameCimMicrosecond(p.cimFileTimeTicks, p.fileTimeTicks), 'token出生不在同CIM微秒')
    assert.equal(utcTicks(p.cimCreationUtc), BigInt(p.cimFileTimeTicks)); assert.equal(utcTicks(p.fileTimeCreationUtc), BigInt(p.fileTimeTicks))
    assert.equal(p.delta100ns, Number(BigInt(p.fileTimeTicks) - BigInt(p.cimFileTimeTicks))); assert.equal(p.birthComparison, 'same-cim-microsecond')
    assert.ok(Number.isSafeInteger(p.parentPid) && p.parentPid > 0)
    assert.ok([0, 4096, 8192, 8448, 12288, 16384, 20480].includes(p.integrityRid)); assert.equal(p.integritySid, 'S-1-16-' + p.integrityRid)
    assert.equal(p.tokenType, 1); assert.ok([1, 2, 3].includes(p.elevationType)); assert.equal(typeof p.isElevated, 'boolean'); assert.equal(typeof p.uiAccess, 'boolean'); assert.ok(Number.isInteger(p.sessionId) && p.sessionId >= 0)
    assert.ok(!(p.elevationType === 2 && !p.isElevated) && !(p.elevationType === 3 && p.isElevated) && !(p.isElevated && p.integrityRid < 12288), 'token elevation矛盾')
    keys(p.linked, ['state', 'exists']); assert.deepEqual(p.linked, p.elevationType === 1 ? { state: 'none-by-default-type', exists: false } : { state: 'present', exists: true })
  }
  assert.equal(proof.app.parentPid, request.parent.pid); assert.equal(proof.app.sessionId, proof.parent.sessionId)
  const ms = (BigInt(proof.app.fileTimeTicks) - 116444736000000000n) / 10000n
  assert.ok(ms >= BigInt(request.app.startedAt) && ms <= BigInt(request.app.returnedAt), 'token app出生不在本轮spawn窗口')
  return structuredClone(proof)
}
// Reflection.Emit只在现有PS/CLR内定义PInvoke，无Add-Type/csc外部子进程或落盘编译物。
// IL紧邻native返回保存LastError，避免PS引擎后续调用污染；固定结构按ABI分配，变长SID才两步探测。
const NATIVE = String.raw`
if([IntPtr]::Size -ne 8){throw 'TOKEN_ABI_POINTER_SIZE'}
$ab=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('WxTokenR11'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$mb=$ab.DefineDynamicModule('m');$tb=$mb.DefineType('WxTokenNative',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$wxError=$tb.DefineField('SavedError',[int],[Reflection.FieldAttributes]'Public,Static')
function Def($name,$dll,$ret,[Type[]]$types){
 $m=$tb.DefineMethod($name+'Core',[Reflection.MethodAttributes]'Private,Static,PinvokeImpl',$ret,$types)
 $a=[Runtime.InteropServices.DllImportAttribute];$f=[Reflection.FieldInfo[]]@($a.GetField('SetLastError'),$a.GetField('CharSet'),$a.GetField('CallingConvention'),$a.GetField('ExactSpelling'),$a.GetField('EntryPoint'))
 $v=[object[]]@($true,[Runtime.InteropServices.CharSet]::Unicode,[Runtime.InteropServices.CallingConvention]::Winapi,$true,$name)
 $m.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($a.GetConstructor(@([string])),[object[]]@($dll),$f,$v));$m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
 $w=$tb.DefineMethod($name,[Reflection.MethodAttributes]'Public,Static',$ret,$types);$il=$w.GetILGenerator();$value=$il.DeclareLocal($ret);$op=[Reflection.Emit.OpCodes]
 for($k=0;$k -lt $types.Length;$k++){$il.Emit($op::Ldarg,[int16]$k)}
 $il.Emit($op::Call,$m);$il.Emit($op::Stloc,$value);$il.Emit($op::Call,[Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error'));$il.Emit($op::Stsfld,$wxError);$il.Emit($op::Ldloc,$value);$il.Emit($op::Ret)
}
$ptr=[IntPtr];$u=[uint32];$i=[int];$pr=$ptr.MakeByRefType();$ur=$u.MakeByRefType()
Def OpenProcess kernel32.dll $ptr @($u,$i,$u)
Def GetProcessTimes kernel32.dll $i @($ptr,$ptr,$ptr,$ptr,$ptr)
Def QueryFullProcessImageNameW kernel32.dll $i @($ptr,$u,$ptr,$ur)
Def CloseHandle kernel32.dll $i @($ptr)
Def LocalFree kernel32.dll $ptr @($ptr)
Def OpenProcessToken advapi32.dll $i @($ptr,$u,$pr)
Def GetTokenInformation advapi32.dll $i @($ptr,$i,$ptr,$u,$ur)
Def IsValidSid advapi32.dll $i @($ptr)
Def GetLengthSid advapi32.dll $u @($ptr)
Def ConvertSidToStringSidW advapi32.dll $i @($ptr,$pr)
$WxNative=$tb.CreateType();$WxMarshal=[Runtime.InteropServices.Marshal];$zero=[IntPtr]::Zero;$TokenLinkedToken=19
function NativeError($api){$e=$WxNative::SavedError;throw ('TOKEN_NATIVE_'+$api+':'+$e)}
function Query($token,[int]$kind){
 $n=[uint32]0
 if(@(8,12,18,20,26) -contains $kind){$n=4}elseif($kind -eq 19){$n=8}else{
  $ok=$WxNative::GetTokenInformation($token,$kind,$zero,0,[ref]$n);$err=$WxNative::SavedError
  if($ok -ne 0 -or $err -ne 122 -or $n -lt 4 -or $n -gt 65536){throw ('TOKEN_BUFFER_SIZE:'+ $kind+':'+$err)}
 }
 $capacity=$n;$p=$WxMarshal::AllocHGlobal([int]$n)
 try{if($WxNative::GetTokenInformation($token,$kind,$p,$capacity,[ref]$n) -eq 0){NativeError 'GetTokenInformation'};if($n -gt $capacity -or $n -lt 4){throw 'TOKEN_BUFFER_RETURN'};return @{p=$p;n=$n}}catch{$WxMarshal::FreeHGlobal($p);throw}
}
function Scalar($token,[int]$kind){$b=Query $token $kind;try{if($b.n -ne 4){throw 'TOKEN_SCALAR_ABI'};return $WxMarshal::ReadInt32($b.p)}finally{$WxMarshal::FreeHGlobal($b.p)}}
function SidValue($token,[int]$kind){
 $b=Query $token $kind;$str=$zero
 try{if($b.n -lt 16){throw 'TOKEN_SID_ABI'};$s=$WxMarshal::ReadIntPtr($b.p)
  if($s.ToInt64() -lt $b.p.ToInt64()+16 -or $s.ToInt64()+8 -gt $b.p.ToInt64()+$b.n){throw 'TOKEN_SID_BOUNDS'}
  if($WxNative::IsValidSid($s) -eq 0){throw 'TOKEN_SID_INVALID'};$len=$WxNative::GetLengthSid($s)
  if($len -lt 8 -or $s.ToInt64()+$len -gt $b.p.ToInt64()+$b.n){throw 'TOKEN_SID_LENGTH'}
  if($WxNative::ConvertSidToStringSidW($s,[ref]$str) -eq 0){NativeError 'ConvertSidToStringSidW'};return $WxMarshal::PtrToStringUni($str)
 }finally{$failed=$false;if($str -ne $zero){if($WxNative::LocalFree($str) -ne $zero){$failed=$true}};$WxMarshal::FreeHGlobal($b.p);if($failed){throw 'TOKEN_SID_FREE'}}
}
function Subject($row,$expected,$sid,$isApp){
 if(!$row -or !$row.CreationDate -or $row.ProcessId -ne $expected.pid -or $row.ExecutablePath -ine $expected.exe){throw 'TOKEN_CIM_OWNER'}
 $cim=[long]$row.CreationDate.ToUniversalTime().ToFileTimeUtc();if($cim % 10 -ne 0){throw 'TOKEN_CIM_PRECISION'}
 $hp=$zero;$ht=$zero;$ft=$zero;$image=$zero
 try{
  $hp=$WxNative::OpenProcess(0x1000,0,[uint32]$expected.pid);if($hp -eq $zero){NativeError 'OpenProcess'}
  $ft=$WxMarshal::AllocHGlobal(32);if($WxNative::GetProcessTimes($hp,$ft,[IntPtr]::Add($ft,8),[IntPtr]::Add($ft,16),[IntPtr]::Add($ft,24)) -eq 0){NativeError 'GetProcessTimes'}
  $file=[long]$WxMarshal::ReadInt64($ft);$delta=$file-$cim
  if($delta -lt 0 -or $delta -gt 9){throw 'TOKEN_BIRTH_MISMATCH'}
  if($isApp){$ms=[Math]::Floor(([decimal]$file-116444736000000000)/10000);if($ms -lt $expected.startedAt -or $ms -gt $expected.returnedAt){throw 'TOKEN_SPAWN_WINDOW'}}
  $image=$WxMarshal::AllocHGlobal(65536);$chars=[uint32]32768
  if($WxNative::QueryFullProcessImageNameW($hp,0,$image,[ref]$chars) -eq 0){NativeError 'QueryFullProcessImageNameW'}
  if($chars -eq 0 -or $chars -gt 32767 -or $WxMarshal::PtrToStringUni($image,[int]$chars) -ine $expected.exe){throw 'TOKEN_EXE_MISMATCH'}
  if($WxNative::OpenProcessToken($hp,0x8,[ref]$ht) -eq 0){NativeError 'OpenProcessToken'}
  $user=SidValue $ht 1;if($user -cne $sid){throw 'TOKEN_SID_MISMATCH'}
  $type=Scalar $ht 8;if($type -ne 1){throw 'TOKEN_NOT_PRIMARY'}
  $il=SidValue $ht 25;if($il -notmatch '^S-1-16-(\d+)$'){throw 'TOKEN_IL_SID'};$rid=[uint32]$Matches[1]
  if(@(0,4096,8192,8448,12288,16384,20480) -notcontains $rid){throw 'TOKEN_IL_UNKNOWN'}
  $elevation=Scalar $ht 20;$et=Scalar $ht 18;$session=Scalar $ht 12;$ui=Scalar $ht 26
  if(@(0,1) -notcontains $elevation -or @(1,2,3) -notcontains $et -or @(0,1) -notcontains $ui -or $session -lt 0){throw 'TOKEN_SCALAR_VALUE'}
  if(($et -eq 2 -and $elevation -ne 1) -or ($et -eq 3 -and $elevation -ne 0) -or ($elevation -eq 1 -and $rid -lt 12288)){throw 'TOKEN_ELEVATION_CONTRADICTION'}
  $linked=@{state='none-by-default-type';exists=$false}
  if($et -ne 1){$b=Query $ht $TokenLinkedToken;$link=$zero;try{if($b.n -ne 8){throw 'TOKEN_LINKED_ABI'};$link=$WxMarshal::ReadIntPtr($b.p);if($link -eq $zero){throw 'TOKEN_LINKED_UNKNOWN'};$linked=@{state='present';exists=$true}}finally{$failed=$false;if($link -ne $zero){if($WxNative::CloseHandle($link) -eq 0){$failed=$true}};$WxMarshal::FreeHGlobal($b.p);if($failed){throw 'TOKEN_LINKED_CLOSE'}}}
  return @{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;exe=$expected.exe;cimCreationUtc=$row.CreationDate.ToUniversalTime().ToString('o');fileTimeCreationUtc=[DateTime]::FromFileTimeUtc($file).ToString('o');cimFileTimeTicks=$cim.ToString();fileTimeTicks=$file.ToString();delta100ns=[int]$delta;birthComparison='same-cim-microsecond';userSid=$user;integritySid=$il;integrityRid=$rid;isElevated=($elevation -eq 1);elevationType=$et;tokenType=$type;sessionId=$session;uiAccess=($ui -eq 1);linked=$linked}
 }finally{
  $failed=$false;if($ht -ne $zero){if($WxNative::CloseHandle($ht) -eq 0){$failed=$true}};if($hp -ne $zero){if($WxNative::CloseHandle($hp) -eq 0){$failed=$true}}
  if($ft -ne $zero){$WxMarshal::FreeHGlobal($ft)};if($image -ne $zero){$WxMarshal::FreeHGlobal($image)};if($failed){throw 'TOKEN_OWNER_CLOSE'}
 }
}
`

export function tokenObservationSource(base, request) {
  if (request === undefined) return base
  validateRequest(request)
  const tail = ';listeners=$listeners}|ConvertTo-Json -Compress -Depth 6'
  assert.ok(base.endsWith(tail), 'token观察只接已有snapshot固定返回形状')
  const marker = ';@{processes=@($owned|ForEach-Object', at = base.indexOf(marker)
  assert.ok(at > 0 && base.indexOf(marker, at + 1) < 0, 'token观察缺唯一snapshot入口')
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64')
  const observe = `$q=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;$ap=@($all|Where-Object {$_.ProcessId -eq $q.app.pid});$pp=@($all|Where-Object {$_.ProcessId -eq $q.parent.pid});if($ap.Count -ne 1 -or $pp.Count -ne 1 -or $ap[0].ParentProcessId -ne $q.parent.pid){throw 'TOKEN_PARENT_OWNER'};$ta=Subject $ap[0] $q.app $q.expectedSid $true;$tp=Subject $pp[0] $q.parent $q.expectedSid $false;if($ta.sessionId -ne $tp.sessionId){throw 'TOKEN_SESSION_MISMATCH'};$tokenObservation=@{mode='readonly-win32-process-primary-token';neverQualification=$true;app=$ta;parent=$tp};`
  const result = NATIVE + base.slice(0, at) + ';' + observe + base.slice(at + 1).replace(tail, ';listeners=$listeners;tokenObservation=$tokenObservation}|ConvertTo-Json -Compress -Depth 6')
  tokenEncodedCommandLength(result); return result
}
