# Local Code Agent Setup Guide

This extension requires a local Ollama server to run models. Follow these steps to get started:

## 1. Install Ollama

### Windows:
- Download from: https://ollama.com/download/ollama-setup.exe
- Run the installer and follow instructions
- Restart your computer if needed

### macOS:
```bash
brew install ollama
```

### Linux:
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

## 2. Start Ollama Server

Start the Ollama service:
```bash
ollama serve
```

This will start the server on `http://127.0.0.1:11434` by default.

## 3. Pull a Model

Download a model for coding assistance:
```bash
ollama pull qwen2.5-coder:14b
```
or
```bash
ollama pull gemma4:latest
```

## 4. Configure Extension

Open the extension settings and make sure:
- Server URL is set to `http://127.0.0.1:11434`
- Model is selected (e.g., `qwen2.5-coder:14b`)

## Troubleshooting

If you still see "model not loaded locally":

1. Verify Ollama is running: `ollama ps`
2. Check that your model is available: `ollama list`
3. Ensure the server URL in settings matches your Ollama instance
4. Restart both Ollama and the browser extension

## Note about Model Selection

This extension supports both local models (like qwen2.5-coder, gemma) and cloud models.
Local models are preferred for better privacy and performance.