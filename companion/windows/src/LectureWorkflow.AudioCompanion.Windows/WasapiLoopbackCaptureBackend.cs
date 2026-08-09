using LectureWorkflow.AudioCompanion.Core;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace LectureWorkflow.AudioCompanion.Windows;

public sealed class WasapiLoopbackCaptureBackendFactory : IAudioCaptureBackendFactory
{
    public IAudioCaptureBackend Create()
    {
        try
        {
            return new WasapiLoopbackCaptureBackend();
        }
        catch (AudioProbeException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw new AudioProbeException(AudioProbeErrorCode.CaptureInitializationFailed, exception);
        }
    }
}

public sealed class WasapiLoopbackCaptureBackend : IAudioCaptureBackend, IMMNotificationClient
{
    private readonly MMDeviceEnumerator enumerator;
    private readonly MMDevice device;
    private readonly WasapiLoopbackCapture capture;
    private readonly string deviceId;
    private int stopped;
    private int disposed;

    public WasapiLoopbackCaptureBackend()
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new AudioProbeException(AudioProbeErrorCode.UnsupportedPlatform);
        }

        MMDeviceEnumerator? createdEnumerator = null;
        MMDevice? createdDevice = null;
        WasapiLoopbackCapture? createdCapture = null;
        try
        {
            createdEnumerator = new MMDeviceEnumerator();
            createdDevice = createdEnumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        }
        catch (Exception exception)
        {
            createdDevice?.Dispose();
            createdEnumerator?.Dispose();
            throw new AudioProbeException(AudioProbeErrorCode.DefaultDeviceUnavailable, exception);
        }

        try
        {
            createdCapture = new WasapiLoopbackCapture(createdDevice);
            AudioInputFormat inputFormat = WaveFormatAdapter.ToInputFormat(createdCapture.WaveFormat);

            enumerator = createdEnumerator;
            device = createdDevice;
            capture = createdCapture;
            deviceId = createdDevice.ID;
            InputFormat = inputFormat;

            capture.DataAvailable += OnDataAvailable;
            capture.RecordingStopped += OnRecordingStopped;
            enumerator.RegisterEndpointNotificationCallback(this);
        }
        catch (Exception exception)
        {
            createdCapture?.Dispose();
            createdDevice?.Dispose();
            createdEnumerator?.Dispose();

            if (exception is AudioProbeException probeException)
            {
                throw probeException;
            }

            throw new AudioProbeException(AudioProbeErrorCode.CaptureInitializationFailed, exception);
        }
    }

    public AudioInputFormat InputFormat { get; }

    public event EventHandler<AudioDataAvailableEventArgs>? DataAvailable;

    public event EventHandler<AudioCaptureStoppedEventArgs>? CaptureStopped;

    public event EventHandler? DefaultDeviceChanged;

    public event EventHandler? DeviceInvalidated;

    public void Start()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        capture.StartRecording();
    }

    public void Stop()
    {
        if (Volatile.Read(ref disposed) == 0 && Interlocked.Exchange(ref stopped, 1) == 0)
        {
            capture.StopRecording();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }

        try
        {
            if (Interlocked.Exchange(ref stopped, 1) == 0)
            {
                capture.StopRecording();
            }
        }
        catch
        {
            // Cleanup must continue even when the endpoint vanished.
        }

        capture.DataAvailable -= OnDataAvailable;
        capture.RecordingStopped -= OnRecordingStopped;
        try
        {
            enumerator.UnregisterEndpointNotificationCallback(this);
        }
        catch
        {
            // The enumerator may already be unavailable during shutdown.
        }

        capture.Dispose();
        device.Dispose();
        enumerator.Dispose();
    }

    public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        if (flow == DataFlow.Render
            && role == Role.Multimedia
            && !string.Equals(defaultDeviceId, deviceId, StringComparison.Ordinal))
        {
            DefaultDeviceChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    public void OnDeviceStateChanged(string changedDeviceId, DeviceState newState)
    {
        if (string.Equals(changedDeviceId, deviceId, StringComparison.Ordinal)
            && newState != DeviceState.Active)
        {
            DeviceInvalidated?.Invoke(this, EventArgs.Empty);
        }
    }

    public void OnDeviceRemoved(string removedDeviceId)
    {
        if (string.Equals(removedDeviceId, deviceId, StringComparison.Ordinal))
        {
            DeviceInvalidated?.Invoke(this, EventArgs.Empty);
        }
    }

    public void OnDeviceAdded(string addedDeviceId)
    {
    }

    public void OnPropertyValueChanged(string changedDeviceId, PropertyKey key)
    {
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs eventArgs)
    {
        DataAvailable?.Invoke(this, new AudioDataAvailableEventArgs(eventArgs.Buffer, eventArgs.BytesRecorded));
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs eventArgs)
    {
        CaptureStopped?.Invoke(this, new AudioCaptureStoppedEventArgs(eventArgs.Exception));
    }
}
