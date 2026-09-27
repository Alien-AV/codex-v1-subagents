$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IdentityProbe {
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
