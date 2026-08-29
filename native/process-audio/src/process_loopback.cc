/* ═══════════════════════════════════════════════════════════════
   CAPTURA DE ÁUDIO POR PROCESSO (WASAPI process loopback)

   POR QUE ISTO EXISTE

   O áudio da tela compartilhada vinha do loopback do sistema inteiro
   (`audio: 'loopback'` no setDisplayMediaRequestHandler). Isso inclui o
   próprio ShareSync reproduzindo o chat de voz, então quem fala se ouve de
   volta, atrasado, dentro do áudio da tela de quem compartilha.

   O Chromium/Electron não expõe nenhuma forma de excluir um aplicativo da
   captura — as únicas opções são 'loopback' (sistema inteiro) e
   'loopbackWithMute'. O Discord não tem esse problema porque não usa
   loopback de sistema: usa a API nativa do Windows que captura (ou exclui)
   o áudio de uma ÁRVORE DE PROCESSOS.

   É essa API que este módulo expõe:
     ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
   com PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE apontando pro
   próprio processo do app. O resultado é "tudo o que toca na máquina,
   MENOS o ShareSync" — jogo, música e vídeo continuam; a voz do chat sai
   de vez, na origem.

   Exige Windows 10 versão 2004 (build 19041) ou superior.

   NOTA SOBRE O FORMATO: diferente do loopback clássico, aqui NÓS
   escolhemos o formato do cliente de áudio em vez de herdar o mix format
   do endpoint de saída. É por isso que este caminho pode funcionar em
   máquinas onde o loopback comum falha com "Could not start audio source"
   por causa de um endpoint multicanal (7.1) — ver CLAUDE.md.
═══════════════════════════════════════════════════════════════ */

#include <napi.h>

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <wrl/implements.h>

#include <algorithm>
#include <atomic>
#include <thread>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 2;
// 20ms por bloco: 50 entregas por segundo. Blocos menores multiplicariam o
// custo de atravessar a ponte pro JS sem ganho perceptível de latência.
constexpr int kFramesPerChunk = kSampleRate / 50;

/* ActivateAudioInterfaceAsync é assíncrona e devolve o resultado por este
   handler. Um evento sinaliza a espera, porque quem chama está numa thread
   dedicada e pode simplesmente bloquear até a ativação terminar. */
class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
 public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler() { if (done_) CloseHandle(done_); }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT hrActivate = S_OK;
    ComPtr<IUnknown> punk;
    HRESULT hr = op->GetActivateResult(&hrActivate, &punk);
    result_ = SUCCEEDED(hr) ? hrActivate : hr;
    if (SUCCEEDED(result_)) punk.As(&client_);
    SetEvent(done_);
    return S_OK;
  }

  HRESULT Wait(DWORD ms) {
    if (WaitForSingleObject(done_, ms) != WAIT_OBJECT_0) return E_FAIL;
    return result_;
  }
  ComPtr<IAudioClient> client_;

 private:
  HANDLE done_ = nullptr;
  HRESULT result_ = E_FAIL;
};

/* Estado da captura. Uma instância só por processo — o app captura no
   máximo uma vez por vez. */
struct Capture {
  std::thread thread;
  std::atomic<bool> running{false};
  Napi::ThreadSafeFunction tsfn;
  std::string error;
  std::atomic<bool> started{false};
  HANDLE readyEvent = nullptr;   // sinaliza que a thread terminou de subir
};

Capture g_capture;

std::string HrToString(const char* what, HRESULT hr) {
  char buf[128];
  snprintf(buf, sizeof(buf), "%s falhou (0x%08lX)", what, static_cast<unsigned long>(hr));
  return std::string(buf);
}

/* A thread de captura: sobe o cliente de áudio, lê blocos e entrega ao JS.
   Tudo relacionado a COM vive aqui dentro — inclusive a inicialização, que
   precisa acontecer na mesma thread que usa as interfaces. */
void CaptureThread(DWORD targetPid, bool includeMode) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialized = SUCCEEDED(hr);

  auto fail = [&](const std::string& msg) {
    g_capture.error = msg;
    g_capture.started = false;
    SetEvent(g_capture.readyEvent);
    if (comInitialized) CoUninitialize();
  };

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = targetPid;
  // EXCLUDE: capta o sistema inteiro MENOS a árvore do processo alvo.
  // É o que tira a voz do chat da captura sem tirar jogo/música junto.
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      includeMode ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                  : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ComPtr<ActivationHandler> handler = Microsoft::WRL::Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                   __uuidof(IAudioClient), &activateParams, handler.Get(), &op);
  if (FAILED(hr)) return fail(HrToString("ActivateAudioInterfaceAsync", hr));

  hr = handler->Wait(3000);
  if (FAILED(hr) || !handler->client_) return fail(HrToString("ativacao do cliente de audio", hr));

  ComPtr<IAudioClient> client = handler->client_;

  // Formato ESCOLHIDO por nós — process loopback não herda o mix format do
  // endpoint de saída, então um dispositivo em 7.1 não atrapalha.
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  fmt.nChannels = kChannels;
  fmt.nSamplesPerSec = kSampleRate;
  fmt.wBitsPerSample = 32;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  fmt.cbSize = 0;

  // hnsBufferDuration = 0: no process loopback quem dimensiona o buffer é
  // o próprio motor de áudio. O exemplo oficial da Microsoft passa 0, e
  // valores diferentes não são suportados neste modo de ativação.
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                          0, 0, &fmt, nullptr);
  if (FAILED(hr)) return fail(HrToString("IAudioClient::Initialize", hr));

  HANDLE bufferEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(bufferEvent);
  if (FAILED(hr)) { CloseHandle(bufferEvent); return fail(HrToString("SetEventHandle", hr)); }

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(__uuidof(IAudioCaptureClient), &capture);
  if (FAILED(hr)) { CloseHandle(bufferEvent); return fail(HrToString("GetService(IAudioCaptureClient)", hr)); }

  hr = client->Start();
  if (FAILED(hr)) { CloseHandle(bufferEvent); return fail(HrToString("IAudioClient::Start", hr)); }

  g_capture.started = true;
  g_capture.error.clear();
  SetEvent(g_capture.readyEvent);

  // Acumula até fechar um bloco de 20ms antes de atravessar pro JS.
  std::vector<float> pending;
  pending.reserve(kFramesPerChunk * kChannels * 2);

  while (g_capture.running.load()) {
    if (WaitForSingleObject(bufferEvent, 200) != WAIT_OBJECT_0) continue;

    UINT32 packetFrames = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packetFrames)) && packetFrames > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;

      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        // Silêncio digital: o Windows não preenche o buffer, mas os quadros
        // contam. Sem inserir os zeros, a trilha andaria mais rápido que o
        // relógio e o áudio dessincronizaria do vídeo com o tempo.
        pending.insert(pending.end(), static_cast<size_t>(frames) * kChannels, 0.0f);
      } else if (data) {
        const float* src = reinterpret_cast<const float*>(data);
        pending.insert(pending.end(), src, src + static_cast<size_t>(frames) * kChannels);
      }
      capture->ReleaseBuffer(frames);

      const size_t chunkSamples = static_cast<size_t>(kFramesPerChunk) * kChannels;
      while (pending.size() >= chunkSamples) {
        auto* chunk = new std::vector<float>(pending.begin(), pending.begin() + chunkSamples);
        pending.erase(pending.begin(), pending.begin() + chunkSamples);

        auto status = g_capture.tsfn.BlockingCall(chunk, [](Napi::Env env, Napi::Function cb,
                                                            std::vector<float>* data) {
          auto buffer = Napi::ArrayBuffer::New(env, data->size() * sizeof(float));
          memcpy(buffer.Data(), data->data(), data->size() * sizeof(float));
          cb.Call({ Napi::Float32Array::New(env, data->size(), buffer, 0) });
          delete data;
        });
        if (status != napi_ok) { delete chunk; break; }
      }
      packetFrames = 0;
    }
  }

  client->Stop();
  CloseHandle(bufferEvent);
  if (comInitialized) CoUninitialize();
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_capture.running.load()) {
    Napi::Error::New(env, "captura já está em andamento").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "esperado um callback").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // PID alvo: por padrão o próprio processo, que é o que queremos EXCLUIR.
  DWORD pid = (info.Length() > 1 && info[1].IsNumber())
      ? static_cast<DWORD>(info[1].As<Napi::Number>().Uint32Value())
      : GetCurrentProcessId();
  // 'include' captura SÓ a árvore do processo alvo; 'exclude' captura tudo
  // menos ela. O app usa 'exclude' com o próprio PID; 'include' serve pra
  // provar, em teste, que os parâmetros estão sendo honrados.
  const bool includeMode = info.Length() > 2 && info[2].IsString()
      && info[2].As<Napi::String>().Utf8Value() == "include";

  g_capture.tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                                 "processLoopback", 0, 1);
  g_capture.readyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  g_capture.running = true;
  g_capture.started = false;
  g_capture.error.clear();
  g_capture.thread = std::thread(CaptureThread, pid, includeMode);

  // Espera a thread subir pra poder responder de verdade se deu certo — sem
  // isso o JS acharia que começou e só descobriria o contrário no silêncio.
  WaitForSingleObject(g_capture.readyEvent, 5000);
  CloseHandle(g_capture.readyEvent);
  g_capture.readyEvent = nullptr;

  if (!g_capture.started.load()) {
    g_capture.running = false;
    if (g_capture.thread.joinable()) g_capture.thread.join();
    g_capture.tsfn.Release();
    Napi::Error::New(env, g_capture.error.empty() ? "falha ao iniciar a captura" : g_capture.error)
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto result = Napi::Object::New(env);
  result.Set("sampleRate", Napi::Number::New(env, kSampleRate));
  result.Set("channels", Napi::Number::New(env, kChannels));
  result.Set("framesPerChunk", Napi::Number::New(env, kFramesPerChunk));
  return result;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_capture.running.load()) return env.Undefined();
  g_capture.running = false;
  if (g_capture.thread.joinable()) g_capture.thread.join();
  g_capture.tsfn.Release();
  return env.Undefined();
}

/* ═══════════════════════════════════════════════════════════════
   QUEM ESTÁ TOCANDO SOM AGORA

   Percorre as sessões de áudio do dispositivo de saída padrão e devolve os
   processos que têm som ativo. É o que alimenta a lista de "transmitir só
   o áudio deste aplicativo" — sem isso a pessoa teria que adivinhar um PID.

   Os nomes vêm do executável (Discord.exe, chrome.exe): o DisplayName da
   sessão quase sempre vem vazio em app de desktop, então não dá pra
   depender dele.
═══════════════════════════════════════════════════════════════ */
std::wstring ProcessName(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return L"";
  wchar_t caminho[MAX_PATH] = {};
  DWORD tam = MAX_PATH;
  std::wstring nome;
  if (QueryFullProcessImageNameW(h, 0, caminho, &tam)) {
    std::wstring completo(caminho, tam);
    const size_t barra = completo.find_last_of(L"\\/");
    nome = (barra == std::wstring::npos) ? completo : completo.substr(barra + 1);
  }
  CloseHandle(h);
  return nome;
}

Napi::Value ListAudioApps(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto lista = Napi::Array::New(env);

  // O chamador é a thread do JS, que pode ou não já ter COM inicializado.
  // RPC_E_CHANGED_MODE significa "já está, em outro modo" — e aí não é
  // nosso o direito de desinicializar depois.
  HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool desinicializar = SUCCEEDED(hrInit);

  ComPtr<IMMDeviceEnumerator> enumerador;
  ComPtr<IMMDevice> dispositivo;
  ComPtr<IAudioSessionManager2> gerenciador;
  ComPtr<IAudioSessionEnumerator> sessoes;
  uint32_t indice = 0;

  if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                 IID_PPV_ARGS(&enumerador)))
      && SUCCEEDED(enumerador->GetDefaultAudioEndpoint(eRender, eConsole, &dispositivo))
      && SUCCEEDED(dispositivo->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL,
                                         nullptr, &gerenciador))
      && SUCCEEDED(gerenciador->GetSessionEnumerator(&sessoes))) {
    int total = 0;
    sessoes->GetCount(&total);
    std::vector<DWORD> jaVistos;

    for (int i = 0; i < total; i++) {
      ComPtr<IAudioSessionControl> controle;
      if (FAILED(sessoes->GetSession(i, &controle))) continue;
      ComPtr<IAudioSessionControl2> controle2;
      if (FAILED(controle.As(&controle2))) continue;
      // Sons do sistema (avisos do Windows) não são um "aplicativo" que
      // alguém escolheria transmitir.
      if (controle2->IsSystemSoundsSession() == S_OK) continue;

      DWORD pid = 0;
      if (FAILED(controle2->GetProcessId(&pid)) || pid == 0) continue;
      if (std::find(jaVistos.begin(), jaVistos.end(), pid) != jaVistos.end()) continue;
      jaVistos.push_back(pid);

      const std::wstring nome = ProcessName(pid);
      if (nome.empty()) continue;

      AudioSessionState estado = AudioSessionStateInactive;
      controle->GetState(&estado);

      auto item = Napi::Object::New(env);
      item.Set("pid", Napi::Number::New(env, pid));
      item.Set("nome", Napi::String::New(env,
        reinterpret_cast<const char16_t*>(nome.c_str()), nome.size()));
      // Ativo = tocando agora. Inativo = tem sessão mas está em silêncio —
      // ainda vale listar, porque o jogo pode estar num menu mudo.
      item.Set("tocando", Napi::Boolean::New(env, estado == AudioSessionStateActive));
      lista.Set(indice++, item);
    }
  }

  if (desinicializar) CoUninitialize();
  return lista;
}

/* Qual processo é dono de uma janela. O seletor de fonte do Electron
   entrega ids como "window:<HWND>:0"; com o HWND dá pra pré-selecionar
   sozinho o áudio do aplicativo que a pessoa escolheu compartilhar. */
Napi::Value WindowProcessId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return Napi::Number::New(env, 0);
  const auto handle = reinterpret_cast<HWND>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  if (!IsWindow(handle)) return Napi::Number::New(env, 0);
  DWORD pid = 0;
  GetWindowThreadProcessId(handle, &pid);
  return Napi::Number::New(env, pid);
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  // A API existe a partir do Windows 10 2004 (build 19041). Abaixo disso o
  // ActivateAudioInterfaceAsync com esses parâmetros falha; melhor dizer
  // antes do que tentar e explicar um HRESULT.
  OSVERSIONINFOEXW osvi = { sizeof(osvi) };
  DWORDLONG mask = 0;
  osvi.dwMajorVersion = 10;
  osvi.dwBuildNumber = 19041;
  VER_SET_CONDITION(mask, VER_MAJORVERSION, VER_GREATER_EQUAL);
  VER_SET_CONDITION(mask, VER_BUILDNUMBER, VER_GREATER_EQUAL);
  const bool ok = VerifyVersionInfoW(&osvi, VER_MAJORVERSION | VER_BUILDNUMBER, mask) != FALSE;
  return Napi::Boolean::New(info.Env(), ok);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("listAudioApps", Napi::Function::New(env, ListAudioApps));
  exports.Set("windowProcessId", Napi::Function::New(env, WindowProcessId));
  return exports;
}

}  // namespace

NODE_API_MODULE(process_audio, Init)
