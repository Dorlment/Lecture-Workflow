# Lecture Workflow Windows Audio Companion POC

This directory contains the Windows-only system-audio probe and protocol-v1 local server for Lecture Workflow.
It captures the current default `Render` / `Multimedia` endpoint through WASAPI
loopback, converts the stream to 16 kHz mono PCM signed 16-bit little-endian, and
reports aggregate frame and RMS statistics only.

Neither mode saves, uploads, transcribes, or logs audio content. A staged development helper can
be launched from the Obsidian classroom workflow after an explicit classroom-session action; it
is never configured as an operating-system startup item or background service.

## Stage the development helper for Obsidian

From the repository root, publish and stage the framework-dependent helper into an existing
Lecture Workflow development plugin directory:

```powershell
npm run stage:audio-companion -- --plugin-dir "D:\path\to\vault\.obsidian\plugins\lecture-workflow"
```

The target must already contain `manifest.json` with plugin ID `lecture-workflow` and `main.js`.
The staging command publishes the Windows executable in Release mode, copies the complete runtime
dependency set produced by `dotnet publish`, filters development-only files such as PDB and logs,
then atomically replaces only `companion/windows`. It does not inspect or modify `data.json`.

The staged layout contains `companion/windows/LectureWorkflow.AudioCompanion.Windows.exe`, the
Core, Protocol and Windows assemblies, `.deps.json`, `.runtimeconfig.json`, and NAudio runtime
dependencies. This is a framework-dependent development build and requires the .NET 10 Desktop
Runtime on the Windows machine. It is not an installer, auto-updater, background service, or
production packaging flow.

## Run the probe

```powershell
dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- probe
```

Play audio through the current default output device. Press Ctrl+C to stop and release
the WASAPI resources. If the default output changes or becomes unavailable, the probe
stops instead of silently switching devices.

The probe deliberately emits no synthetic silence frames. When the playback stream is
silent, WASAPI loopback may produce no callbacks; the status reporter remains idle
instead of polling in a busy loop. An incomplete final 20 ms frame is discarded when
the probe stops.

## Build and test

```powershell
dotnet restore LectureWorkflow.AudioCompanion.Windows.sln
dotnet build LectureWorkflow.AudioCompanion.Windows.sln
dotnet test --solution LectureWorkflow.AudioCompanion.Windows.sln
```

## Run the protocol server

Provide a runtime-only unpadded Base64URL token through standard input. The server hashes it
immediately and keeps only the SHA-256 digest until the host stops. It never echoes the token.

```powershell
dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server --token-stdin
```

The server listens only on IPv4 `ws://127.0.0.1:43127/v1/audio`. Although the TypeScript client
validator reserves `localhost` and `[::1]` for compatible helpers, those forms are not guaranteed
by this Windows implementation. It never binds a LAN address or `0.0.0.0`.

For a device-free end-to-end protocol check:

```powershell
dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server-self-test
```

The self-test uses a generated in-memory token and deterministic synthetic frames. It exercises
HELLO/READY and two START/STOP cycles without opening WASAPI or logging audio bytes.

For an explicit Windows WASAPI end-to-end check, start the server in one terminal and run the
following development client in another, entering the same token through standard input:

```powershell
dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- server-test-client --token-stdin
```

The client prints only frame counts and aggregate RMS. Ctrl+C requests STOP and waits for
`STATUS stopped`; it never saves or prints PCM.

## One-paste default-device-change acceptance test

The following PowerShell block is a development-only acceptance harness, not an installer,
startup service, or production pairing flow. Run it from the repository root after building the
Windows solution. It generates one runtime token in the current PowerShell process, passes it to
each child only through redirected standard input, and never uses the clipboard, a file, command-line
arguments, or environment variables for the token.

Play audio after the first client starts, then change the Windows default output device. The first
client must report `SOURCE_UNAVAILABLE`. The script then starts a second client with the same
in-memory token; that client runs for ten seconds and performs a normal protocol STOP. The server
stops when the script closes its standard-input pipe.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $repoRoot = (Get-Location).Path
    $executable = Join-Path $repoRoot 'companion/windows/src/LectureWorkflow.AudioCompanion.Windows/bin/Debug/net10.0-windows/LectureWorkflow.AudioCompanion.Windows.exe'
    if (-not (Test-Path -LiteralPath $executable)) {
        throw '未找到已构建的音频助手。请先从仓库根目录运行 dotnet build companion/windows/LectureWorkflow.AudioCompanion.Windows.sln。'
    }

    $tokenBytes = $null
    $pairingToken = $null
    $rng = $null
    $server = $null
    $firstClient = $null
    $secondClient = $null

    function Start-AudioCompanionProcess {
        param(
            [Parameter(Mandatory)] [string[]] $ChildArguments,
            [Parameter(Mandatory)] [string] $PairingToken,
            [Parameter(Mandatory)] [bool] $KeepStandardInputOpen
        )

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $executable
        $startInfo.WorkingDirectory = $repoRoot
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardInput = $true
        $startInfo.Arguments = [string]::Join(' ', $ChildArguments)

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void] $process.Start()
        $process.StandardInput.WriteLine($PairingToken)
        $process.StandardInput.Flush()
        if (-not $KeepStandardInputOpen) {
            $process.StandardInput.Close()
        }

        return $process
    }

    function Stop-AudioCompanionProcess {
        param([System.Diagnostics.Process] $Process)
        if ($null -eq $Process) {
            return
        }

        try {
            if (-not $Process.HasExited) {
                try { $Process.StandardInput.Close() } catch { }
                if (-not $Process.WaitForExit(5000)) {
                    $Process.Kill()
                    [void] $Process.WaitForExit(5000)
                }
            }
        }
        finally {
            $Process.Dispose()
        }
    }

    function Test-AudioCompanionPort {
        $client = New-Object System.Net.Sockets.TcpClient
        $asyncResult = $null
        $waitHandle = $null
        try {
            $asyncResult = $client.BeginConnect('127.0.0.1', 43127, $null, $null)
            $waitHandle = $asyncResult.AsyncWaitHandle
            if (-not $waitHandle.WaitOne(500)) {
                return $false
            }

            $client.EndConnect($asyncResult)
            return $true
        }
        catch {
            return $false
        }
        finally {
            if ($null -ne $waitHandle) {
                $waitHandle.Close()
            }
            $client.Close()
            $client.Dispose()
        }
    }

    try {
        $tokenBytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $rng.GetBytes($tokenBytes)
        }
        finally {
            $rng.Dispose()
        }
        $pairingToken = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)

        $server = Start-AudioCompanionProcess -PairingToken $pairingToken -KeepStandardInputOpen $true -ChildArguments @(
            'server', '--token-stdin', '--stop-on-stdin-eof'
        )

        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while ($true) {
            if ($server.HasExited) {
                throw '音频助手服务在启动期间退出；错误码：server-exited-before-ready。'
            }

            if (Test-AudioCompanionPort) {
                break
            }

            if ([DateTime]::UtcNow -ge $deadline) {
                throw '等待音频助手服务启动超时；错误码：server-readiness-timeout。'
            }
            Start-Sleep -Milliseconds 200
        }

        Write-Host '第一个客户端已启动。请播放声音，然后切换 Windows 默认输出设备。'
        $firstClient = Start-AudioCompanionProcess -PairingToken $pairingToken -KeepStandardInputOpen $false -ChildArguments @(
            'server-test-client', '--token-stdin'
        )
        $firstClient.WaitForExit()
        if ($server.HasExited) {
            throw '第一个连接结束后服务不应退出。'
        }

        Write-Host '第一个客户端已结束；正在复用同一临时凭据启动第二个客户端。'
        $secondClient = Start-AudioCompanionProcess -PairingToken $pairingToken -KeepStandardInputOpen $false -ChildArguments @(
            'server-test-client', '--token-stdin', '--duration-seconds', '10'
        )
        $secondClient.WaitForExit()
        if ($secondClient.ExitCode -ne 0) {
            throw '第二个客户端未正常完成。'
        }

        $server.StandardInput.Close()
        if (-not $server.WaitForExit(10000) -or $server.ExitCode -ne 0) {
            throw '音频助手服务未正常停止。'
        }
        Write-Host '验收流程完成：第二次连接成功，客户端和服务均已停止。'
    }
    finally {
        Stop-AudioCompanionProcess $secondClient
        Stop-AudioCompanionProcess $firstClient
        Stop-AudioCompanionProcess $server
        $portReleased = $false
        $portDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $portDeadline) {
            if (-not (Test-AudioCompanionPort)) {
                $portReleased = $true
                break
            }
            Start-Sleep -Milliseconds 200
        }
        if ($null -ne $tokenBytes) {
            [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
        }
        $rng = $null
        $pairingToken = $null
        $tokenBytes = $null
        if (-not $portReleased) {
            throw '音频助手端口未能释放；错误码：acceptance-port-still-in-use。'
        }
    }
}
```

The byte array is zeroed as soon as the Base64URL value is created and again during cleanup. The
immutable .NET string cannot be actively zeroed; the script only shortens its lifetime, clears its
variable reference, and never caches or prints it.
