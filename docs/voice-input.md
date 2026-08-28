# Local voice input

Tabby Sync release builds ship a macOS Apple Silicon runtime and the `GigaAM v3 E2E CTC Q4_K_M` GGUF model. The model runs fully on-device through Metal and recognizes short Russian utterances with punctuation and normalization.

The 174 MB model is intentionally excluded from Git because it is larger than GitHub's 100 MB per-file limit. Before building from a source checkout, put the model at `extras/voice/gigaam-v3-e2e-ctc-Q4_K_M.gguf`, or select an equivalent compatible GGUF file in **Settings → Voice input**. The locally installed application may still contain the bundled model; `.gitignore` only keeps it out of commits.

Open the command shelf, choose the ✨ assistant view, and press the microphone button in the request field. macOS will ask for microphone permission the first time. Press the button again to stop; recording also stops automatically after 25 seconds. In this assistant-shelf flow, the recognized text is placed in the editable request field and is not sent anywhere until the user subsequently presses **Ask**.

The microphone button in an active terminal uses the same local recognizer and inserts the result as one editable line without pressing Enter. The transcript is normalized to NFC and transported as one UTF-8 write. On macOS/Linux, local shells receive a valid UTF-8 `LC_CTYPE`; this also repairs GUI-launch environments such as `C.UTF-8` on macOS, which macOS otherwise treats as US-ASCII and displays as octal `\\320\\...` byte sequences. Windows builds use ConPTY Unicode transport and enable UTF-8 for Python-based command helpers.

Settings are available in **Settings → Voice input**. The advanced paths are only for using a separately installed compatible `transcribe-cli` runtime or another local GGUF model.

## Privacy

The audio is converted in the renderer to a 16 kHz mono WAV, written to a private temporary directory only for local inference, then removed. Neither audio nor transcription is uploaded to PostgreSQL or a model API by the voice-input feature.

## Technical limits

`GigaAM v3 E2E CTC` is optimized for Russian and recordings up to 25 seconds. The release `Q4_K_M` model is approximately 174 MB. Release builds include the runtime and model for macOS on Apple Silicon; source checkouts and other platforms can use the advanced paths after providing a compatible local runtime and model.
