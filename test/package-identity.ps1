param([uint32] $ConsoleProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IdentityProbe {
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool SetStdHandle(int handle, IntPtr value);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    public static bool ConsoleVisible(uint processId) {
        var input = GetStdHandle(-10);
        var output = GetStdHandle(-11);
        var error = GetStdHandle(-12);
        FreeConsole();
        try {
            if (!AttachConsole(processId)) {
                int code = Marshal.GetLastWin32Error();
                if (code == 6) return false; // The target has no console.
                throw new System.ComponentModel.Win32Exception(code, "Couldn't inspect the Node console");
            }
            return IsWindowVisible(GetConsoleWindow());
        } finally {
            FreeConsole();
            SetStdHandle(-10, input);
            SetStdHandle(-11, output);
            SetStdHandle(-12, error);
        }
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern int GetCurrentPackageFullName(ref uint length, StringBuilder value);
    public static string Read() {
        uint length = 0;
        int status = GetCurrentPackageFullName(ref length, null);
        if (status != 122) throw new Exception("Package identity missing: " + status);
        var name = new StringBuilder((int)length);
        status = GetCurrentPackageFullName(ref length, name);
        if (status != 0) throw new Exception("Package identity query failed: " + status);
        return name.ToString();
    }
}
'@
[IdentityProbe]::Read()
if ($ConsoleProcessId) {
    if ([IdentityProbe]::ConsoleVisible($ConsoleProcessId)) { throw 'The packaged Node console is visible' }
    Write-Output 'Node console is hidden'
}
