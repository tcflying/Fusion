import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useVoiceDictation } from "../useVoiceDictation";

import { __resetVoiceAvailabilityCache } from "../useVoiceAvailability";

function Harness() {
  const voice = useVoiceDictation();
  return <>
    <output data-testid="voice">{JSON.stringify({ enabled: voice.enabled, supported: voice.supported, partialText: voice.partialText, finalText: voice.finalText })}</output>
    <button onClick={() => void voice.start()}>start</button>
    <button onClick={() => void voice.stop()}>stop</button>
  </>;
}

function availableResponses() {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/voice/status") return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
    if (url === "/api/voice/session") return new Response(JSON.stringify({ sessionId: "session-1" }), { status: 201 });
    if (url === "/api/voice/transcribe") return new Response(JSON.stringify({ text: "final transcript", final: true }));
    if (url === "/api/voice/session/session-1" && init?.method === "DELETE") return new Response("{}");
    throw new Error(`Unexpected request ${url}`);
  });
}

function installAudioCapture() {
  const tracks = [{ stop: vi.fn() }];
  const port = { onmessage: undefined as ((event: MessageEvent<ArrayBuffer>) => void) | undefined };
  class Context {
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    close = vi.fn().mockResolvedValue(undefined);
  }
  vi.stubGlobal("AudioWorkletNode", class { port = port; disconnect = vi.fn(); });
  Object.defineProperty(window, "AudioContext", { configurable: true, value: Context });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => tracks }) } });
  return { tracks, port };
}

describe("useVoiceDictation", () => {
  beforeEach(() => {
    __resetVoiceAvailabilityCache();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.useRealTimers());

  it("fails closed while status is pending or fails", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(<Harness />);
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/voice/status"));
    expect(screen.getByTestId("voice").textContent).toContain('"enabled":false');
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
  });

  it("keeps capture unavailable while voice status is disabled", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ enabled: false, runtime: { status: "available" }, model: { status: "installed" } })));
    render(<Harness />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/voice/status"));
    expect(screen.getByTestId("voice").textContent).toContain('"enabled":false');
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
  });

  it("fails closed when AudioWorkletNode is unavailable", async () => {
    installAudioCapture();
    vi.stubGlobal("AudioWorkletNode", undefined);
    availableResponses();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"enabled":true'));
    expect(screen.getByTestId("voice").textContent).toContain('"supported":false');
  });

  it("serializes buffered worklet frames and sends a bounded finalization", async () => {
    const { tracks, port } = installAudioCapture();
    availableResponses();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await act(async () => {
      // A full 200ms batch starts one ordered request; the remaining frame flushes on stop.
      port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>);
      port.onmessage?.({ data: new ArrayBuffer(256) } as MessageEvent<ArrayBuffer>);
    });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe").length).toBe(1));
    fireEvent.click(screen.getByText("stop"));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe").length).toBe(2));
    const requests = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe");
    expect(JSON.parse(String(requests.at(-1)?.[1]?.body))).toMatchObject({ final: true, sequence: 1 });
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"finalText":"final transcript"'));
    expect(tracks[0].stop).toHaveBeenCalledOnce();
  });

  it("releases microphone tracks immediately when an in-flight transcription never settles", async () => {
    const { tracks, port } = installAudioCapture();
      vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/voice/status") return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
      if (url === "/api/voice/session") return new Response(JSON.stringify({ sessionId: "session-1" }), { status: 201 });
      if (url === "/api/voice/transcribe" && !JSON.parse(String(init?.body)).final) return await new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({ text: "", final: true }));
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await act(async () => { port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>); });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/voice/transcribe")).toBe(true));
    fireEvent.click(screen.getByText("stop"));
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    // A request already in flight may have reached the server, so stop releases the track but
    // waits for that original sequence instead of replaying PCM as a second request.
    await act(async () => undefined);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/transcribe")).toHaveLength(1);
  });

  it("bounds a stalled pre-stop flush, aborts its request, and deletes only that session", async () => {
    const { port } = installAudioCapture();
    let stalledSignal: AbortSignal | undefined;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/voice/status") return new Response(JSON.stringify({ enabled: true, runtime: { status: "available" }, model: { status: "installed" } }));
      if (url === "/api/voice/session") return new Response(JSON.stringify({ sessionId: "session-1" }), { status: 201 });
      if (url === "/api/voice/transcribe") {
        stalledSignal = init?.signal as AbortSignal;
        return await new Promise<Response>(() => undefined);
      }
      if (url === "/api/voice/session/session-1" && init?.method === "DELETE") return new Response("{}");
      throw new Error(`Unexpected request ${url}`);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    await act(async () => { port.onmessage?.({ data: new ArrayBuffer(6_400) } as MessageEvent<ArrayBuffer>); });
    await waitFor(() => expect(stalledSignal).toBeDefined());
    vi.useFakeTimers();
    fireEvent.click(screen.getByText("stop"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(stalledSignal?.aborted).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/voice/session/session-1" && init?.method === "DELETE")).toBe(true);
  });

  it("prevents a rapid double-start from creating multiple captures", async () => {
    const { port } = installAudioCapture();
    availableResponses();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toContain('"supported":true'));
    fireEvent.click(screen.getByText("start"));
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(port.onmessage).toBeTypeOf("function"));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/voice/session").length).toBe(1);
  });
});
