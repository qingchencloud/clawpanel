using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

// 仅自有 fixture 的边界观察与 barrier；不是生产 reader/hash 替代实现。
public sealed class ClawBoundaryEvent {
  public int seq, file, active;
  public long elapsedMs;
  public string stage;
}
public sealed class ClawBoundaryRelease {
  public int seq;
  public bool entered, returned, marker, reaped;
  public int literalCalls;
}
public static class ClawBoundaryControl {
  public static string[] Paths;
  public static string Mode;
  public static Stopwatch Clock;
  public static int Active, Peak, MaxJobs;
  public static int[] Calls = new int[4];
  public static ClawBoundaryRelease BeforeRelease;
  static readonly object Sync = new object();
  static readonly List<ClawBoundaryEvent> Log = new List<ClawBoundaryEvent>();
  static readonly CountdownEvent FirstPair = new CountdownEvent(2);
  static readonly ManualResetEventSlim Release = new ManualResetEventSlim(false);
  static readonly ManualResetEventSlim AReturned = new ManualResetEventSlim(false);
  public static int Index(string p) {
    int i = Array.IndexOf(Paths, p);
    if(i < 0) throw new InvalidOperationException("outside owned fixture files");
    return i;
  }
  static void Add(string stage, int file) {
    lock(Sync) Log.Add(new ClawBoundaryEvent {seq=Log.Count+1,file=file,stage=stage,active=Active,elapsedMs=Clock.ElapsedMilliseconds});
  }
  static bool Seen(string stage, int file) {
    return Log.Exists(e => e.stage == stage && e.file == file);
  }
  static void Await(ManualResetEventSlim gate) {
    if(!gate.Wait(5000)) throw new TimeoutException("owned boundary barrier timeout");
  }
  public static void Enter(string p) {
    int i=Index(p);
    lock(Sync) {Active++; Peak=Math.Max(Peak,Active); Add("api-enter",i);}
    if(i < 2) {FirstPair.Signal(); if(!FirstPair.Wait(5000)) throw new TimeoutException("owned pair did not overlap");}
    if(i == 0 && Mode == "before") Await(Release);
    if(i != 0 && Mode == "after") Await(AReturned);
  }
  public static void Literal(string p) {
    int i=Index(p);
    lock(Sync) {Calls[i]++; Add("literal-call",i);}
  }
  public static void Returned(string p) {
    int i=Index(p); Add("api-return",i);
    if(i == 0) {AReturned.Set(); if(Mode == "after") Await(Release);}
  }
  public static void Failed(string p) {Add("api-throw",Index(p));}
  public static void Leave(string p) {lock(Sync) {Active--; Add("api-leave",Index(p));}}
  public static void Marker(string p) {Add("end-marker-return",Index(p));}
  public static void Reaped(string p) {
    int i=Index(p); Add("endinvoke-return",i);
    if(i == 3 && (Mode == "before" || Mode == "after")) {
      lock(Sync) {
        BeforeRelease=new ClawBoundaryRelease {seq=Log.Count,entered=Seen("api-enter",0),returned=Seen("api-return",0),marker=Seen("end-marker-return",0),reaped=Seen("endinvoke-return",0),literalCalls=Calls[0]};
        Add("release-a",0);
      }
      Release.Set();
    }
  }
  public static void Created(string p, int count) {
    lock(Sync) {MaxJobs=Math.Max(MaxJobs,count); Add("job-created",Index(p));}
  }
  public static void Disposed(string p) {Add("job-disposed",Index(p));}
  public static ClawBoundaryEvent[] Events() {lock(Sync) return Log.ToArray();}
}
