using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexV1Subagents
{
    // Windows' Desktop AppX activator. Options 6 keep the external Node host and
    // its children in the installed package context; 8 suppresses broker dialogs.
    [ComImport, Guid("F158268A-D5A5-45CE-99CF-00D6C3F3FC0A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDesktopAppXActivator
    {
        void Activate([MarshalAs(UnmanagedType.LPWStr)] string id,
            [MarshalAs(UnmanagedType.LPWStr)] string exe,
            [MarshalAs(UnmanagedType.LPWStr)] string args, out IntPtr process);
        void ActivateWithOptions([MarshalAs(UnmanagedType.LPWStr)] string id,
            [MarshalAs(UnmanagedType.LPWStr)] string exe,
            [MarshalAs(UnmanagedType.LPWStr)] string args,
            uint options, uint parent, out IntPtr process);
        void ActivateWithOptionsAndArgs([MarshalAs(UnmanagedType.LPWStr)] string id,
            [MarshalAs(UnmanagedType.LPWStr)] string exe,
            [MarshalAs(UnmanagedType.LPWStr)] string args,
            uint parent, IntPtr activatedEventArgs, out IntPtr process);
        void ActivateWithOptionsArgsWorkingDirectoryShowWindow([MarshalAs(UnmanagedType.LPWStr)] string id,
            [MarshalAs(UnmanagedType.LPWStr)] string exe,
            [MarshalAs(UnmanagedType.LPWStr)] string args,
            uint options, uint parent, IntPtr activatedEventArgs,
            [MarshalAs(UnmanagedType.LPWStr)] string workingDirectory,
            uint showWindow, out IntPtr process);
    }

    public static class PackageLauncher
    {
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances,
            uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes security);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);

        public static string QuoteArgument(string value)
        {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c);
                slashes = 0;
            }
            result.Append('\\', slashes * 2);
            return result.Append('"').ToString();
        }

        static NamedPipeServerStream CreatePrivatePipe(string name)
        {
            IntPtr descriptor;
            string sid = WindowsIdentity.GetCurrent().User.Value;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;" + sid + ")", 1, out descriptor, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Couldn't secure the launcher pipe");
            try
            {
                var security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
                // Duplex, overlapped, first instance; reject remote clients.
                var handle = CreateNamedPipe(@"\\.\pipe\" + name, 0x40080003, 8, 1, 65536, 65536, 0, ref security);
                if (handle.IsInvalid)
                {
                    int error = Marshal.GetLastWin32Error();
                    handle.Dispose();
                    throw new Win32Exception(error, "Couldn't create the private launcher pipe");
                }
                try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
                catch { handle.Dispose(); throw; }
            }
            finally { LocalFree(descriptor); }
        }

        public static int Run(string node, string script, string appId, string packageFullName, string startupJson)
        {
            string pipeName = "codex-v1-launch-" + Guid.NewGuid().ToString("N");
            object activator = null;
            IntPtr process = IntPtr.Zero;
            bool completed = false;
            using (var pipe = CreatePrivatePipe(pipeName))
            {
                try
                {
                    var connection = pipe.BeginWaitForConnection(null, null);
                    activator = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("168EB462-775F-42AE-9111-D714B2306C2E")));
                    // SW_HIDE applies to the Node host only, not Codex's own UI.
                    ((IDesktopAppXActivator)activator).ActivateWithOptionsArgsWorkingDirectoryShowWindow(appId, node,
                        QuoteArgument(script) + " " + QuoteArgument(pipeName), 6 | 8 | 32, 0, IntPtr.Zero,
                        Path.GetDirectoryName(script), 0, out process);

                    uint length = 0;
                    int status = GetPackageFullName(process, ref length, null);
                    if (status != 122)
                        throw new InvalidOperationException("Windows did not assign Codex package identity (error " + status + ")");
                    var actual = new StringBuilder((int)length);
                    status = GetPackageFullName(process, ref length, actual);
                    if (status != 0 || !String.Equals(actual.ToString(), packageFullName, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("Package identity expected " + packageFullName + ", got " + actual + " (error " + status + ")");

                    DateTime deadline = DateTime.UtcNow.AddSeconds(20);
                    while (!connection.AsyncWaitHandle.WaitOne(100))
                    {
                        if (WaitForSingleObject(process, 0) == 0)
                            throw new InvalidOperationException("The packaged Node launcher exited before connecting");
                        if (DateTime.UtcNow >= deadline)
                            throw new TimeoutException("The packaged Node launcher did not connect within 20 seconds");
                    }
                    pipe.EndWaitForConnection(connection);
                    connection.AsyncWaitHandle.Close();
                    uint clientPid;
                    if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid) || clientPid != GetProcessId(process))
                        throw new InvalidOperationException("Rejected an unexpected process on the launcher pipe");

                    var encoding = new UTF8Encoding(false);
                    using (var writer = new StreamWriter(pipe, encoding, 4096, true))
                    using (var reader = new StreamReader(pipe, encoding, false, 4096, true))
                    {
                        writer.WriteLine(startupJson);
                        writer.Flush();
                        string line;
                        while ((line = reader.ReadLine()) != null) Console.WriteLine(line);
                    }
                    if (WaitForSingleObject(process, 10000) != 0)
                        throw new TimeoutException("The packaged launcher disconnected but did not exit");
                    uint code;
                    if (!GetExitCodeProcess(process, out code))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Couldn't read the launcher exit code");
                    completed = true;
                    return unchecked((int)code);
                }
                finally
                {
                    if (process != IntPtr.Zero)
                    {
                        if (!completed) TerminateProcess(process, 1);
                        CloseHandle(process);
                    }
                    if (activator != null) Marshal.ReleaseComObject(activator);
                }
            }
        }
    }
}
