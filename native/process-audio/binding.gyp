{
  "targets": [
    {
      "target_name": "process_audio",
      "sources": ["src/process_loopback.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "_WIN32_WINNT=0x0A00"
      ],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["-lmmdevapi.lib", "-lole32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 0,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}
