/* ═══════════════════════════════════════════════════════════════
   CAPTURA DE ÁUDIO POR PROCESSO (WASAPI process loopback)

   POR QUE ISTO EXISTE

   O áudio da tela compartilhada vinha do loopback do sistema inteiro
   (`audio: 'loopback'` no setDisplayMediaRequestHandler). Isso inclui o
   próprio ShareSync reproduzindo o chat de voz, então quem fala se ouve de
   volta, atrasado, dentro do áudio da tela de quem compartilha.

   O Chromium/Electron não expõe forma de excluir um aplicativo da captura
   — as únicas opções são 'loopback' (sistema inteiro) e 'loopbackWithMute'.
   O Discord não tem esse problema porque usa a API nativa do Windows que
   captura (ou exclui) o áudio de uma ÁRVORE DE PROCESSOS. É essa API que
   este módulo expõe:

     ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK

   Exige Windows 10 versão 2004 (build 19041) ou superior.

   TRÊS MODOS

   1. exclude <pid>  — tudo da máquina MENOS a árvore daquele processo.
      É o padrão, apontando pro próprio app: tira a voz do chat e mantém
      jogo, música e vídeo.
   2. include <pid>  — SÓ a árvore daquele processo. "Transmitir apenas o
      som deste aplicativo": deixa de fora Discord, navegador, tudo.
   3. multi          — uma captura INCLUDE por aplicativo com áudio que NÃO
      esteja na lista de exclusão, todas somadas numa saída só.

   O modo 3 existe porque AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS tem UM
   TargetProcessId: não há como pedir "menos Discord E menos ShareSync"
   para um único cliente de áudio. A saída equivalente se constrói somando
   várias capturas — que é o que o misturador aqui faz.

   NOTA SOBRE O FORMATO: diferente do loopback clássico, aqui NÓS
   escolhemos o formato do cliente em vez de herdar o mix format do
   endpoint. É por isso que este caminho funciona em máquinas onde o
   loopback comum falha com "Could not start audio source" por causa de um
   endpoint multicanal (7.1) — ver CLAUDE.md.
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
#include <memory>
#include <mutex>
#include <string>
#include <thread>
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
constexpr size_t kSamplesPerChunk = static_cast<size_t>(kFramesPerChunk) * kChannels;
// Teto por fonte: 1s. Se o misturador travar, é melhor perder o áudio mais
// velho do que crescer sem limite.
constexpr size_t kMaxBuffered = static_cast<size_t>(kSampleRate) * kChannels;
// De quanto em quanto tempo procurar aplicativos que começaram (ou pararam)
// de tocar durante a transmissão.
constexpr int kScanIntervalMs = 2000;

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

std::string HrToString(const char* what, HRESULT hr) {
  char buf[128];
  snprintf(buf, sizeof(buf), "%s falhou (0x%08lX)", what, static_cast<unsigned long>(hr));
  return std::string(buf);
}

/* ═══════════════════════════════════════════════════════════════
   UMA FONTE = UMA CAPTURA
   Cada fonte tem sua thread e seu próprio acúmulo de amostras. Quem soma
   tudo e entrega ao JS é o misturador — assim o modo de uma fonte só e o
   de várias percorrem exatamente o mesmo caminho de saída.
═══════════════════════════════════════════════════════════════ */
struct Source {
  DWORD pid = 0;
  bool include = true;
  std::thread thread;
  std::atomic<bool> running{false};
  std::atomic<bool> started{false};
  std::string error;
  std::mutex mtx;
  std::vector<float> buffer;
  HANDLE readyEvent = nullptr;
};

struct Engine {
  std::vector<std::unique_ptr<Source>> sources;
  std::mutex sourcesMtx;
  std::thread mixer;
  std::thread scanner;
  std::atomic<bool> running{false};
  Napi::ThreadSafeFunction tsfn;
  bool multi = false;
  std::vector<std::wstring> excludeExes;  // minúsculas, com extensão
};

Engine g;

std::wstring ToLower(std::wstring s) {
  std::transform(s.begin(), s.end(), s.begin(), ::towlower);
  return s;
}

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

/* Processos com sessão de áudio no dispositivo de saída padrão.
   `comNome` recebe (pid, executável, tocando). Assume COM já inicializado
   na thread chamadora. */
template <typename F>
void ForEachAudioSession(F comNome) {
  ComPtr<IMMDeviceEnumerator> enumerador;
  ComPtr<IMMDevice> dispositivo;
  ComPtr<IAudioSessionManager2> gerenciador;
  ComPtr<IAudioSessionEnumerator> sessoes;

  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              IID_PPV_ARGS(&enumerador)))) return;
  if (FAILED(enumerador->GetDefaultAudioEndpoint(eRender, eConsole, &dispositivo))) return;
  if (FAILED(dispositivo->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL,
                                   nullptr, &gerenciador))) return;
  if (FAILED(gerenciador->GetSessionEnumerator(&sessoes))) return;

  int total = 0;
  sessoes->GetCount(&total);
  for (int i = 0; i < total; i++) {
    ComPtr<IAudioSessionControl> controle;
    if (FAILED(sessoes->GetSession(i, &controle))) continue;
    ComPtr<IAudioSessionControl2> controle2;
    if (FAILED(controle.As(&controle2))) continue;
    // Sons do sistema (avisos do Windows) não são um "aplicativo".
    if (controle2->IsSystemSoundsSession() == S_OK) continue;

    DWORD pid = 0;
    if (FAILED(controle2->GetProcessId(&pid)) || pid == 0) continue;
    const std::wstring nome = ProcessName(pid);
    if (nome.empty()) continue;

    AudioSessionState estado = AudioSessionStateInactive;
    controle->GetState(&estado);
    comNome(pid, nome, estado == AudioSessionStateActive);
  }
}

/* ── A thread de uma fonte: sobe o cliente e acumula amostras ── */
void SourceThread(Source* src) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialized = SUCCEEDED(hr);

  auto fail = [&](const std::string& msg) {
    src->error = msg;
    src->started = false;
    if (src->readyEvent) SetEvent(src->readyEvent);
    if (comInitialized) CoUninitialize();
  };

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = src->pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      src->include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
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

  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  fmt.nChannels = kChannels;
  fmt.nSamplesPerSec = kSampleRate;
  fmt.wBitsPerSample = 32;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  fmt.cbSize = 0;

  // hnsBufferDuration = 0: neste modo de ativação quem dimensiona o buffer
  // é o motor de áudio. O exemplo oficial da Microsoft passa 0, e valores
  // diferentes não são suportados aqui.
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                          0, 0, &fmt, nullptr);
  if (FAILED(hr)) return fail(HrToString("IAudioClient::Initialize", hr));

  HANDLE bufferEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(bufferEvent);
  if (FAILED(hr)) { CloseHandle(bufferEvent); return fail(HrToString("SetEventHandle", hr)); }

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(__uuidof(IAudioCaptureClient), &capture);
  if (FAILED(hr)) { CloseHandle(bufferEvent); return fail(HrToString("GetService", hr)); }

  hr = client->Start();
  if (FAILED(hr)) { CloseHandle(bufferEvent); return fail(HrToString("IAudioClient::Start", hr)); }

  src->started = true;
  src->error.clear();
  if (src->readyEvent) SetEvent(src->readyEvent);

  while (src->running.load()) {
    if (WaitForSingleObject(bufferEvent, 200) != WAIT_OBJECT_0) continue;

    UINT32 packetFrames = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packetFrames)) && packetFrames > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;

      {
        std::lock_guard<std::mutex> lock(src->mtx);
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          // Silêncio digital: o Windows não preenche o buffer, mas os
          // quadros contam. Sem inserir os zeros, a trilha andaria mais
          // rápido que o relógio e dessincronizaria do vídeo com o tempo.
          src->buffer.insert(src->buffer.end(),
                             static_cast<size_t>(frames) * kChannels, 0.0f);
        } else if (data) {
          const float* p = reinterpret_cast<const float*>(data);
          src->buffer.insert(src->buffer.end(), p,
                             p + static_cast<size_t>(frames) * kChannels);
        }
        if (src->buffer.size() > kMaxBuffered) {
          src->buffer.erase(src->buffer.begin(),
                            src->buffer.begin() + (src->buffer.size() - kMaxBuffered));
        }
      }
      capture->ReleaseBuffer(frames);
      packetFrames = 0;
    }
  }

  client->Stop();
  CloseHandle(bufferEvent);
  if (comInitialized) CoUninitialize();
}

/* ── O misturador: soma as fontes e entrega blocos ao JS ──
   Todas as fontes são loopback do MESMO endpoint, então compartilham o
   relógio do motor de áudio e não derivam entre si. O ritmo de saída segue
   a fonte que tem mais amostras acumuladas; uma que esteja atrás entra com
   o que tem (o resto vira zero naquele bloco), em vez de segurar todo o
   mundo esperando por ela. */
void MixerThread() {
  std::vector<float> mix(kSamplesPerChunk);

  while (g.running.load()) {
    size_t maiorDisponivel = 0;
    {
      std::lock_guard<std::mutex> lock(g.sourcesMtx);
      for (auto& s : g.sources) {
        std::lock_guard<std::mutex> l2(s->mtx);
        maiorDisponivel = (std::max)(maiorDisponivel, s->buffer.size());
      }
    }

    if (maiorDisponivel < kSamplesPerChunk) {
      std::this_thread::sleep_for(std::chrono::milliseconds(4));
      continue;
    }

    std::fill(mix.begin(), mix.end(), 0.0f);
    {
      std::lock_guard<std::mutex> lock(g.sourcesMtx);
      for (auto& s : g.sources) {
        std::lock_guard<std::mutex> l2(s->mtx);
        const size_t levar = (std::min)(s->buffer.size(), kSamplesPerChunk);
        for (size_t i = 0; i < levar; i++) mix[i] += s->buffer[i];
        s->buffer.erase(s->buffer.begin(), s->buffer.begin() + levar);
      }
    }

    // Somar várias fontes pode estourar a faixa [-1, 1]. Ceifar é
    // preferível a normalizar: normalizar mudaria o volume de tudo toda
    // vez que um app novo começasse a tocar.
    for (auto& v : mix) v = (std::max)(-1.0f, (std::min)(1.0f, v));

    auto* chunk = new std::vector<float>(mix);
    auto status = g.tsfn.BlockingCall(chunk, [](Napi::Env env, Napi::Function cb,
                                                std::vector<float>* data) {
      auto buffer = Napi::ArrayBuffer::New(env, data->size() * sizeof(float));
      memcpy(buffer.Data(), data->data(), data->size() * sizeof(float));
      cb.Call({ Napi::Float32Array::New(env, data->size(), buffer, 0) });
      delete data;
    });
    if (status != napi_ok) { delete chunk; break; }
  }
}

// Sobe uma fonte e espera ela abrir. Devolve false (e não a registra) se
// o cliente de áudio recusar — um app pode sumir entre o scan e o start.
bool AddSource(DWORD pid, bool include, std::string* erro) {
  auto src = std::make_unique<Source>();
  src->pid = pid;
  src->include = include;
  src->running = true;
  src->readyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Source* raw = src.get();
  src->thread = std::thread(SourceThread, raw);

  WaitForSingleObject(raw->readyEvent, 5000);
  CloseHandle(raw->readyEvent);
  raw->readyEvent = nullptr;

  if (!raw->started.load()) {
    if (erro) *erro = raw->error.empty() ? "falha ao iniciar a captura" : raw->error;
    raw->running = false;
    if (raw->thread.joinable()) raw->thread.join();
    return false;
  }

  std::lock_guard<std::mutex> lock(g.sourcesMtx);
  g.sources.push_back(std::move(src));
  return true;
}

void StopAllSources() {
  std::vector<std::unique_ptr<Source>> paraParar;
  {
    std::lock_guard<std::mutex> lock(g.sourcesMtx);
    paraParar.swap(g.sources);
  }
  for (auto& s : paraParar) {
    s->running = false;
    if (s->thread.joinable()) s->thread.join();
  }
}

/* ── O vigia: aplicativos começam e param de tocar durante a transmissão ──
   Sem isso, abrir um vídeo no navegador depois de já estar transmitindo
   não mandaria som nenhum, e um app fechado deixaria uma captura parada
   pendurada até o fim. */
void ScannerThread() {
  const DWORD ownPid = GetCurrentProcessId();
  const std::wstring ownExe = ToLower(ProcessName(ownPid));

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comInitialized = SUCCEEDED(hr);

  while (g.running.load()) {
    std::vector<DWORD> permitidos;
    ForEachAudioSession([&](DWORD pid, const std::wstring& exe, bool) {
      if (pid == ownPid) return;
      const std::wstring lower = ToLower(exe);
      // O próprio app nunca entra: é justamente a voz do chat que não pode
      // voltar pela transmissão.
      if (lower == ownExe) return;
      for (const auto& bloqueado : g.excludeExes) if (lower == bloqueado) return;
      permitidos.push_back(pid);
    });

    // Fontes que não estão mais na lista (app fechou ou entrou na exclusão)
    std::vector<std::unique_ptr<Source>> remover;
    {
      std::lock_guard<std::mutex> lock(g.sourcesMtx);
      for (auto it = g.sources.begin(); it != g.sources.end();) {
        const bool aindaVale =
            std::find(permitidos.begin(), permitidos.end(), (*it)->pid) != permitidos.end();
        if (aindaVale) { ++it; continue; }
        remover.push_back(std::move(*it));
        it = g.sources.erase(it);
      }
    }
    for (auto& s : remover) {
      s->running = false;
      if (s->thread.joinable()) s->thread.join();
    }

    // Aplicativos novos
    for (DWORD pid : permitidos) {
      bool jaTem = false;
      {
        std::lock_guard<std::mutex> lock(g.sourcesMtx);
        for (auto& s : g.sources) if (s->pid == pid) { jaTem = true; break; }
      }
      if (!jaTem) AddSource(pid, true, nullptr);
    }

    for (int i = 0; i < kScanIntervalMs / 50 && g.running.load(); i++) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  }

  if (comInitialized) CoUninitialize();
}

Napi::Object FormatInfo(Napi::Env env, int fontes) {
  auto result = Napi::Object::New(env);
  result.Set("sampleRate", Napi::Number::New(env, kSampleRate));
  result.Set("channels", Napi::Number::New(env, kChannels));
  result.Set("framesPerChunk", Napi::Number::New(env, kFramesPerChunk));
  result.Set("fontes", Napi::Number::New(env, fontes));
  return result;
}

void StopEngine() {
  if (!g.running.load()) return;
  g.running = false;
  if (g.scanner.joinable()) g.scanner.join();
  if (g.mixer.joinable()) g.mixer.join();
  StopAllSources();
  g.tsfn.Release();
  g.excludeExes.clear();
  g.multi = false;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g.running.load()) {
    Napi::Error::New(env, "captura já está em andamento").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "esperado um callback").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  DWORD pid = (info.Length() > 1 && info[1].IsNumber())
      ? static_cast<DWORD>(info[1].As<Napi::Number>().Uint32Value())
      : GetCurrentProcessId();
  const bool include = info.Length() > 2 && info[2].IsString()
      && info[2].As<Napi::String>().Utf8Value() == "include";

  g.tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                         "processLoopback", 0, 1);
  g.running = true;
  g.multi = false;

  std::string erro;
  if (!AddSource(pid, include, &erro)) {
    g.running = false;
    g.tsfn.Release();
    Napi::Error::New(env, erro).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  g.mixer = std::thread(MixerThread);
  return FormatInfo(env, 1);
}

/* Captura tudo o que toca na máquina MENOS uma lista de executáveis (o
   próprio app entra na lista automaticamente). Uma captura INCLUDE por
   aplicativo permitido, somadas pelo misturador — a API não aceita uma
   lista de exclusão num cliente só. */
Napi::Value StartExcluding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g.running.load()) {
    Napi::Error::New(env, "captura já está em andamento").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "esperado um callback").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  g.excludeExes.clear();
  if (info.Length() > 1 && info[1].IsArray()) {
    auto lista = info[1].As<Napi::Array>();
    for (uint32_t i = 0; i < lista.Length(); i++) {
      Napi::Value v = lista.Get(i);
      if (!v.IsString()) continue;
      const std::u16string s = v.As<Napi::String>().Utf16Value();
      g.excludeExes.push_back(ToLower(std::wstring(s.begin(), s.end())));
    }
  }

  g.tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                         "processLoopbackMulti", 0, 1);
  g.running = true;
  g.multi = true;

  // O vigia monta as fontes iniciais na primeira volta e vai mantendo a
  // lista em dia enquanto a transmissão durar.
  g.scanner = std::thread(ScannerThread);
  g.mixer = std::thread(MixerThread);

  // Dá um instante pro vigia abrir as primeiras fontes, só pra poder
  // responder quantas entraram.
  std::this_thread::sleep_for(std::chrono::milliseconds(600));
  size_t fontes = 0;
  {
    std::lock_guard<std::mutex> lock(g.sourcesMtx);
    fontes = g.sources.size();
  }
  return FormatInfo(env, static_cast<int>(fontes));
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  StopEngine();
  return info.Env().Undefined();
}

Napi::Value ListAudioApps(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto lista = Napi::Array::New(env);

  // O chamador é a thread do JS, que pode ou não já ter COM inicializado.
  // RPC_E_CHANGED_MODE significa "já está, em outro modo" — e aí não é
  // nosso o direito de desinicializar depois.
  HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool desinicializar = SUCCEEDED(hrInit);

  uint32_t indice = 0;
  std::vector<DWORD> jaVistos;
  ForEachAudioSession([&](DWORD pid, const std::wstring& nome, bool tocando) {
    if (std::find(jaVistos.begin(), jaVistos.end(), pid) != jaVistos.end()) return;
    jaVistos.push_back(pid);
    auto item = Napi::Object::New(env);
    item.Set("pid", Napi::Number::New(env, pid));
    item.Set("nome", Napi::String::New(env,
      reinterpret_cast<const char16_t*>(nome.c_str()), nome.size()));
    item.Set("tocando", Napi::Boolean::New(env, tocando));
    lista.Set(indice++, item);
  });

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

// Quantas capturas estão no ar agora — o modo multi varia com o que está
// tocando, e sem isso não haveria como mostrar (nem depurar) isso.
Napi::Value ActiveSources(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g.sourcesMtx);
  return Napi::Number::New(info.Env(), static_cast<double>(g.sources.size()));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("startExcluding", Napi::Function::New(env, StartExcluding));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("listAudioApps", Napi::Function::New(env, ListAudioApps));
  exports.Set("windowProcessId", Napi::Function::New(env, WindowProcessId));
  exports.Set("activeSources", Napi::Function::New(env, ActiveSources));
  return exports;
}

}  // namespace

NODE_API_MODULE(process_audio, Init)
