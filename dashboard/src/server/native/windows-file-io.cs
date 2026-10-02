using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace LearningLoop {
public sealed class BoundWorker {
  const uint Read = 0x80000000, Write = 0x40000000, Delete = 0x10000;
  const uint DirectoryFlag = 0x02000000, ReparseFlag = 0x00200000;
  const uint AttrDirectory = 16, AttrReparse = 1024;
  const int Block = 65536, Frame = 131072;
  // At most two 2,000-file snapshots plus their bounded course directories and
  // ownership markers. These are metadata/delete handles, not active streams.
  const int CleanupHandles = 4400;
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Modified;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder value, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
  [StructLayout(LayoutKind.Sequential)] struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Security, Quality; }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle,uint access,ref ObjectAttributes attributes,out IoStatus status,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle,out IoStatus status,IntPtr buffer,uint length,int kind);
  [DllImport("ntdll.dll")] static extern int NtQueryDirectoryFile(SafeFileHandle handle,IntPtr signal,IntPtr apc,IntPtr context,out IoStatus status,IntPtr buffer,uint length,int kind,[MarshalAs(UnmanagedType.U1)] bool single,IntPtr name,[MarshalAs(UnmanagedType.U1)] bool restart);
  sealed class NativeEntry { public string Full; public uint Attributes; }
  sealed class Failure : Exception {
    public int Status; public string Code;
    public Failure(string message, int status, string code) : base(message) { Status=status; Code=code; }
  }
  sealed class Lease : IDisposable {
    public List<SafeFileHandle> Parents = new List<SafeFileHandle>(); public SafeFileHandle Leaf; public FileStream Stream;
    public IEnumerator<NativeEntry> Entries; public long Limit, Count; public bool Writer; public string Identity, Target;
    public void Dispose() {
      try { if (Entries != null) Entries.Dispose(); }
      finally {
        try { if (Stream != null) Stream.Dispose(); }
        finally {
          if (Leaf != null) Leaf.Dispose();
          for (int index=Parents.Count-1; index>=0; index--) Parents[index].Dispose();
        }
      }
    }
  }
  readonly Dictionary<string, Lease> leases = new Dictionary<string, Lease>();
  readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=Frame, RecursionLimit=16 };
  static string Normalize(string name) {
    if (String.IsNullOrEmpty(name) || name.Length>1000 || name.IndexOf('\0')>=0 || name.StartsWith("\\\\") || name.Length<3 || name[1]!=':' || (name[2]!='\\' && name[2]!='/')) throw new Failure("仅支持安全的本地绝对路径",422,"EINVAL");
    string full=Path.GetFullPath(name).TrimEnd('\\'); if (full.Length==2) full += "\\";
    foreach(string part in full.Substring(3).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries)) {
      if (part.EndsWith(".") || part.EndsWith(" ") || part.IndexOf(':')>=0 || part.IndexOfAny(new char[]{'*','?','<','>','|','"'})>=0) throw new Failure("路径名称不安全",422,"EINVAL");
      string stem=part.Split('.')[0].ToUpperInvariant();
      if (stem=="CON" || stem=="PRN" || stem=="AUX" || stem=="NUL" || (stem.Length==4 && (stem.StartsWith("COM") || stem.StartsWith("LPT")) && stem[3]>='1' && stem[3]<='9')) throw new Failure("设备路径不安全",422,"EINVAL");
    }
    return full;
  }
  static Failure WinError() { return WinError(Marshal.GetLastWin32Error()); }
  static Failure WinError(int error) {
    string code=(error==2 || error==3)?"ENOENT":(error==80 || error==183)?"EEXIST":(error==32 || error==33)?"EBUSY":"EACCES";
    return new Failure("Windows 安全文件操作失败 ("+error+")",422,code);
  }
  static Info Details(SafeFileHandle handle) { Info info; if (!GetFileInformationByHandle(handle,out info)) throw WinError(); return info; }
  static string Identity(Info info) { return info.Volume+":"+info.IndexHigh+":"+info.IndexLow+":"+info.SizeHigh+":"+info.SizeLow+":"+info.Modified.dwHighDateTime+":"+info.Modified.dwLowDateTime; }
  static SafeFileHandle Open(string full, uint access, uint share, uint disposition, bool directory, SafeFileHandle parent=null) {
    // Only the drive root may use an absolute Win32 path. Every descendant is
    // a single name resolved against an already-held actual directory object.
    SafeFileHandle handle;
    if(parent==null) {
      if(!String.Equals(full,Path.GetPathRoot(full),StringComparison.OrdinalIgnoreCase)) throw new Failure("缺少绑定父目录",422,"EINVAL");
      handle=CreateFileW(full,access|1,share,IntPtr.Zero,disposition,DirectoryFlag|ReparseFlag,IntPtr.Zero);
    } else {
      string name=Path.GetFileName(full); if(String.IsNullOrEmpty(name) || name.IndexOfAny(new char[]{'\\','/',':'})>=0) throw new Failure("无效单级名称",422,"EINVAL");
      IntPtr text=Marshal.StringToHGlobalUni(name), unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
      try {
        UnicodeName value=new UnicodeName { Length=(ushort)(name.Length*2), MaximumLength=(ushort)(name.Length*2+2), Buffer=text }; Marshal.StructureToPtr(value,unicode,false);
        ObjectAttributes attributes=new ObjectAttributes { Length=(uint)Marshal.SizeOf(typeof(ObjectAttributes)), Root=parent.DangerousGetHandle(), Name=unicode, Attributes=0x40 };
        IoStatus status; uint desired=access|0x100080U|(directory?1U:0U);
        uint create=disposition==1?2U:disposition==4?3U:1U;
        int result=NtCreateFile(out handle,desired,ref attributes,out status,IntPtr.Zero,128,share,create,0x00200020U|(directory?1U:0x40U),IntPtr.Zero,0);
        if(result<0) { if(handle!=null) handle.Dispose(); throw WinError((int)RtlNtStatusToDosError(result)); }
      } finally { Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
    }
    if (handle.IsInvalid) { handle.Dispose(); throw WinError(); }
    try {
      Info info=Details(handle);
      if ((info.Attributes & AttrReparse)!=0) throw new Failure("拒绝链接或 reparse point",422,"EINVAL");
      if (((info.Attributes & AttrDirectory)!=0)!=directory) throw new Failure("不是预期的普通文件或目录",422,"EINVAL");
      if (!directory && info.Links!=1) throw new Failure("拒绝多重硬链接文件",422,"EINVAL");
      StringBuilder value=new StringBuilder(4096); uint length=GetFinalPathNameByHandleW(handle,value,(uint)value.Capacity,0);
      if (length==0 || length>=value.Capacity) throw new Failure("无法核验句柄路径",422,"EINVAL");
      string final=value.ToString(); if (final.StartsWith("\\\\?\\")) final=final.Substring(4);
      if (!String.Equals(final.TrimEnd('\\'),full.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new Failure("文件句柄路径不安全",422,"EINVAL");
      return handle;
    } catch { handle.Dispose(); throw; }
  }
  static void Disposition(SafeFileHandle handle, bool delete) {
    IntPtr data=Marshal.AllocHGlobal(1);
    try { Marshal.WriteByte(data,delete?(byte)1:(byte)0); if (!SetFileInformationByHandle(handle,4,data,1)) throw WinError(); }
    finally { Marshal.FreeHGlobal(data); }
  }
  static void RenameHandle(SafeFileHandle handle,string destination,bool replace,SafeFileHandle parent) {
    byte[] filename=Encoding.Unicode.GetBytes(Path.GetFileName(destination)); int rootOffset=IntPtr.Size==8?8:4;
    int lengthOffset=rootOffset+IntPtr.Size, nameOffset=lengthOffset+4, size=nameOffset+filename.Length+2;
    IntPtr data=Marshal.AllocHGlobal(size);
    try {
      for(int index=0;index<size;index++) Marshal.WriteByte(data,index,0);
      Marshal.WriteByte(data,replace?(byte)1:(byte)0); Marshal.WriteIntPtr(data,rootOffset,parent.DangerousGetHandle());
      Marshal.WriteInt32(data,lengthOffset,filename.Length); Marshal.Copy(filename,0,IntPtr.Add(data,nameOffset),filename.Length);
      IoStatus status; int result=NtSetInformationFile(handle,out status,data,(uint)size,10);
      if(result<0) throw WinError((int)RtlNtStatusToDosError(result));
    } finally { Marshal.FreeHGlobal(data); }
  }
  void VerifyOwner(string full,Dictionary<string,object> request,SafeFileHandle directory) {
    object raw; if (!request.TryGetValue("owner",out raw) || !(raw is Dictionary<string,object>)) throw new Failure("恢复目录所有权缺失",422,"EINVAL");
    Dictionary<string,object> owner=(Dictionary<string,object>)raw;
    using(SafeFileHandle marker=Open(Path.Combine(full,".learning-loop-restore.json"),Read,1,3,false,directory)) {
      Info details=Details(marker); if(details.SizeHigh!=0 || details.SizeLow>1000) throw new Failure("恢复目录所有权无效",422,"EINVAL");
      using(FileStream stream=new FileStream(marker,FileAccess.Read)) using(StreamReader reader=new StreamReader(stream,new UTF8Encoding(false,true))) {
        Dictionary<string,object> actual=json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
        foreach(string key in new string[]{"id","token","newId"}) if(Text(actual,key)!=Text(owner,key)) throw new Failure("恢复目录所有权校验失败",422,"EINVAL");
      }
    }
  }
  static IEnumerable<NativeEntry> EnumerateBound(string full,SafeFileHandle handle) {
    IntPtr buffer=Marshal.AllocHGlobal(Block); bool restart=true;
    try {
      while(true) {
        IoStatus status; int result=NtQueryDirectoryFile(handle,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,out status,buffer,Block,1,false,IntPtr.Zero,restart); restart=false;
        if(result==unchecked((int)0x80000006)) yield break;
        if(result<0) throw WinError((int)RtlNtStatusToDosError(result));
        ulong size=status.Information.ToUInt64(); if(size==0 || size>Block) throw new Failure("目录响应无效",422,"EIO");
        int offset=0;
        while(true) {
          if((ulong)(offset+64)>size) throw new Failure("目录条目无效",422,"EIO");
          int next=Marshal.ReadInt32(buffer,offset), length=Marshal.ReadInt32(buffer,offset+60);
          if(length<0 || length%2!=0 || (ulong)(offset+64+length)>size) throw new Failure("目录名称无效",422,"EIO");
          string name=Marshal.PtrToStringUni(IntPtr.Add(buffer,offset+64),length/2);
          if(name!="." && name!="..") yield return new NativeEntry { Full=Path.Combine(full,name), Attributes=unchecked((uint)Marshal.ReadInt32(buffer,offset+56)) };
          if(next==0) break;
          if(next<64 || (ulong)(offset+next)>=size) throw new Failure("目录偏移无效",422,"EIO"); offset+=next;
        }
      }
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static void CollectTree(string full,SafeFileHandle handle,List<SafeFileHandle> ordered,int depth) {
    if(depth>8 || ordered.Count>=CleanupHandles) throw new Failure("清理目录结构超限",413,"EFBIG");
    foreach(NativeEntry entry in EnumerateBound(full,handle)) {
      if(ordered.Count>=CleanupHandles) throw new Failure("清理目录条目超限",413,"EFBIG");
      string child=entry.Full; uint attributes=entry.Attributes;
      bool directory=(attributes & AttrDirectory)!=0;
      SafeFileHandle opened=Open(child,Delete,3,3,directory,handle); ordered.Add(opened);
      if(directory) CollectTree(child,opened,ordered,depth+1);
    }
  }
  static Lease BindParents(string full, bool create, bool exclusiveLeaf, bool includeLeaf) {
    Lease lease=new Lease(); string root=Path.GetPathRoot(full); string current=root;
    try {
      lease.Parents.Add(Open(root,0,3,3,true));
      string[] parts=full.Substring(root.Length).Split(new char[]{'\\'},StringSplitOptions.RemoveEmptyEntries);
      int count=includeLeaf?parts.Length:parts.Length-1;
      for (int index=0;index<count;index++) {
        current=Path.Combine(current,parts[index]);
        uint disposition=create?(exclusiveLeaf && index==count-1?1U:4U):3U;
        lease.Parents.Add(Open(current,0,3,disposition,true,lease.Parents[lease.Parents.Count-1]));
      }
      return lease;
    } catch { lease.Dispose(); throw; }
  }
  static string Text(Dictionary<string,object> request,string key) { object value; if (!request.TryGetValue(key,out value) || !(value is string)) throw new Failure("无效请求字段",422,"EINVAL"); return (string)value; }
  static long Limit(Dictionary<string,object> request) { object value; if (!request.TryGetValue("limit",out value)) throw new Failure("缺少文件上限",422,"EINVAL"); long limit=Convert.ToInt64(value); if (limit<0 || limit>104857600) throw new Failure("文件上限无效",413,"EFBIG"); return limit; }
  string Add(Lease lease) {
    if (leases.Count>=16) { lease.Dispose(); throw new Failure("活动文件数量超限",413,"EMFILE"); }
    string token=Guid.NewGuid().ToString("N"); leases.Add(token,lease); return token;
  }
  Lease Get(Dictionary<string,object> request) { Lease lease; if (!leases.TryGetValue(Text(request,"token"),out lease)) throw new Failure("文件句柄已关闭",422,"EBADF"); return lease; }
  void Close(Dictionary<string,object> request) { string token=Text(request,"token"); Lease lease=Get(request); leases.Remove(token); lease.Dispose(); }
  object Execute(Dictionary<string,object> request) {
    string command=Text(request,"command");
    if (command=="ping") return new { protocol=1 };
    if (command=="ensure") {
      string full=Normalize(Text(request,"path")); bool exclusive=request.ContainsKey("exclusiveLeaf") && Convert.ToBoolean(request["exclusiveLeaf"]);
      using(Lease lease=BindParents(full,true,exclusive,true)) { } return new {};
    }
    if(command=="ownedDirectory") {
      string full=Normalize(Text(request,"path"));
      using(Lease parents=BindParents(full,false,false,false)) {
        using(SafeFileHandle directory=Open(full,Delete,3,1,true,parents.Parents[parents.Parents.Count-1])) {
          object owner; if(!request.TryGetValue("owner",out owner)) throw new Failure("缺少目录所有权",422,"EINVAL");
          byte[] bytes=Encoding.UTF8.GetBytes(json.Serialize(owner)); if(bytes.Length>1000) throw new Failure("目录所有权超限",413,"EFBIG");
          using(SafeFileHandle file=Open(Path.Combine(full,".learning-loop-restore.json"),Write|Delete,0,1,false,directory)) {
            Disposition(file,true); using(FileStream stream=new FileStream(file,FileAccess.Write)) { stream.Write(bytes,0,bytes.Length); stream.Flush(); if(!FlushFileBuffers(file)) throw WinError(); Disposition(file,false); }
          }
        }
      } return new {};
    }
    if(command=="moveDirectory") {
      string source=Normalize(Text(request,"path")), destination=Normalize(Text(request,"destination"));
      using(Lease sourceParents=BindParents(source,false,false,false)) using(Lease destinationParents=BindParents(destination,false,false,false))
      using(SafeFileHandle directory=Open(source,Delete,3,3,true,sourceParents.Parents[sourceParents.Parents.Count-1])) {
        VerifyOwner(source,request,directory); RenameHandle(directory,destination,false,destinationParents.Parents[destinationParents.Parents.Count-1]);
      } return new {};
    }
    if(command=="removeDirectory") {
      string full=Normalize(Text(request,"path"));
      using(Lease parents=BindParents(full,false,false,false)) using(SafeFileHandle directory=Open(full,Delete,3,3,true,parents.Parents[parents.Parents.Count-1])) {
        VerifyOwner(full,request,directory); List<SafeFileHandle> ordered=new List<SafeFileHandle>();
        try {
          CollectTree(full,directory,ordered,0);
          // Open and validate the complete tree before the first deletion.
          for(int index=ordered.Count-1;index>=0;index--) { Disposition(ordered[index],true); ordered[index].Dispose(); }
          Disposition(directory,true);
        } finally { foreach(SafeFileHandle handle in ordered) handle.Dispose(); }
      } return new {};
    }
    if (command=="openRead" || command=="openWrite" || command=="openState") {
      string full=Normalize(Text(request,"path")); long limit=Limit(request); Lease lease=BindParents(full,false,false,false);
      try {
        lease.Writer=command!="openRead"; lease.Limit=limit;
        if(command=="openState") {
          if(limit>2097152) throw new Failure("状态文件大小超限",413,"EFBIG");
          try { using(SafeFileHandle existing=Open(full,0,7,3,false,lease.Parents[lease.Parents.Count-1])) {} }
          catch(Failure error) { if(error.Code!="ENOENT") throw; }
          lease.Target=full; full=Path.Combine(Path.GetDirectoryName(full),Guid.NewGuid().ToString()+".tmp");
        }
        lease.Leaf=Open(full,lease.Writer?(Write|Delete):Read,lease.Writer?0U:1U,lease.Writer?1U:3U,false,lease.Parents[lease.Parents.Count-1]);
        Info info=Details(lease.Leaf); lease.Identity=Identity(info); long length=((long)info.SizeHigh<<32)|info.SizeLow;
        if (length>limit) throw new Failure("文件大小超限",413,"EFBIG");
        if (lease.Writer) Disposition(lease.Leaf,true);
        lease.Stream=new FileStream(lease.Leaf,lease.Writer?FileAccess.Write:FileAccess.Read,Block,false);
        string token=Add(lease); return new { token=token, identity=lease.Identity };
      } catch { lease.Dispose(); throw; }
    }
    if (command=="read") {
      Lease lease=Get(request); if (lease.Writer || lease.Stream==null) throw new Failure("读取句柄无效",422,"EBADF");
      byte[] bytes=new byte[Block]; int count=lease.Stream.Read(bytes,0,bytes.Length); lease.Count+=count;
      if (lease.Count>lease.Limit) throw new Failure("实际读取超限",413,"EFBIG");
      return new { bytes=Convert.ToBase64String(bytes,0,count) };
    }
    if (command=="write") {
      Lease lease=Get(request); if (!lease.Writer || lease.Stream==null) throw new Failure("写入句柄无效",422,"EBADF");
      byte[] bytes=Convert.FromBase64String(Text(request,"bytes"));
      if (bytes.Length>Block || bytes.Length>lease.Limit-lease.Count) throw new Failure("实际写入超限",413,"EFBIG");
      lease.Stream.Write(bytes,0,bytes.Length); lease.Count+=bytes.Length; return new {};
    }
    if (command=="finishWrite" || command=="finishState") {
      Lease lease=Get(request); if (!lease.Writer) throw new Failure("写入句柄无效",422,"EBADF");
      lease.Stream.Flush(); if (!FlushFileBuffers(lease.Leaf)) throw WinError(); Disposition(lease.Leaf,false);
      if(command=="finishState") {
        if(lease.Target==null) throw new Failure("状态句柄无效",422,"EBADF");
        try { RenameHandle(lease.Leaf,lease.Target,true,lease.Parents[lease.Parents.Count-1]); } catch { Disposition(lease.Leaf,true); throw; }
      }
      Close(request); return new {};
    }
    if (command=="abortWrite" || command=="closeRead" || command=="closeList") { Close(request); return new {}; }
    if (command=="openList") {
      string full=Normalize(Text(request,"path")); Lease lease=BindParents(full,false,false,true);
      try { lease.Identity=Identity(Details(lease.Parents[lease.Parents.Count-1])); lease.Entries=EnumerateBound(full,lease.Parents[lease.Parents.Count-1]).GetEnumerator(); return new { token=Add(lease), identity=lease.Identity }; }
      catch { lease.Dispose(); throw; }
    }
    if (command=="list") {
      Lease lease=Get(request); if (lease.Entries==null) throw new Failure("枚举句柄无效",422,"EBADF");
      List<object> entries=new List<object>(); bool done=false;
      for (int index=0; index<128;index++) {
        if (!lease.Entries.MoveNext()) { done=true; break; }
        NativeEntry entry=lease.Entries.Current; string filename=entry.Full; uint attributes=entry.Attributes;
        string kind=(attributes & AttrReparse)!=0?"link":(attributes & AttrDirectory)!=0?"directory":"file";
        entries.Add(new { name=Path.GetFileName(filename), kind=kind });
      }
      return new { entries=entries, done=done };
    }
    throw new Failure("不支持的固定文件命令",422,"EINVAL");
  }
  void Output(object value) { string raw=json.Serialize(value); if (Encoding.UTF8.GetByteCount(raw)>Frame) throw new Failure("响应帧超限",413,"EFBIG"); Console.Out.WriteLine(raw); Console.Out.Flush(); }
  static string ReadFrame() {
    StringBuilder value=new StringBuilder(); int next;
    while ((next=Console.In.Read())!=-1) { if (next==10) return value.ToString(); if (value.Length>=Frame) throw new Failure("请求帧超限",413,"EFBIG"); value.Append((char)next); }
    return value.Length==0?null:value.ToString();
  }
  public static void Run() {
    BoundWorker worker=new BoundWorker(); long activity=DateTime.UtcNow.Ticks;
    using(Timer watchdog=new Timer(delegate(object unused) { if (DateTime.UtcNow.Ticks-Interlocked.Read(ref activity)>TimeSpan.FromSeconds(15).Ticks) Environment.Exit(2); },null,1000,1000)) {
      try {
        worker.Output(new { ok=true, result=new { protocol=1 } }); string line;
        while ((line=ReadFrame())!=null) {
          Interlocked.Exchange(ref activity,DateTime.UtcNow.Ticks);
          try {
            if (Encoding.UTF8.GetByteCount(line)>Frame) throw new Failure("请求帧超限",413,"EFBIG");
            Dictionary<string,object> request=worker.json.Deserialize<Dictionary<string,object>>(line);
            worker.Output(new { ok=true, result=worker.Execute(request) });
          } catch(Failure error) { worker.Output(new { ok=false, error=error.Message, code=error.Code, status=error.Status }); }
          catch { worker.Output(new { ok=false, error="Windows 安全文件操作失败", code="EIO", status=422 }); }
          Interlocked.Exchange(ref activity,DateTime.UtcNow.Ticks);
        }
      } finally { foreach(Lease lease in worker.leases.Values) lease.Dispose(); }
    }
  }
}
}
