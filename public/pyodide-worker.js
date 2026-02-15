// Pyodide Web Worker with matplotlib support
let pyodide = null;
let settings = {
  loadMicropip: false,
  libs: [],
};

// JS function exposed to Python — posts a single output item immediately
function postOutput(kind, content) {
  self.postMessage({ type: "output", kind, content });
}
self.postOutput = postOutput;

const DISPLAY_SETUP = `
import sys, os
from js import postOutput

# Force Agg backend via env var — only takes effect if/when matplotlib is imported.
os.environ['MPLBACKEND'] = 'Agg'

class _StreamCapture:
    def __init__(self, kind):
        from io import StringIO
        self._buf = StringIO()
        self._kind = kind

    def write(self, text):
        self._buf.write(text)
        if '\\n' in text:
            self.drain()

    def flush(self):
        self.drain()

    def drain(self):
        text = self._buf.getvalue()
        if text:
            postOutput(self._kind, text)
            from io import StringIO
            self._buf = StringIO()

    def getvalue(self):
        return self._buf.getvalue()

_stdout_capture = _StreamCapture("text")
_stderr_capture = _StreamCapture("error")
_original_stdout = sys.stdout
_original_stderr = sys.stderr

def _capture_figures():
    """Capture any open matplotlib figures. No-op if matplotlib is not installed."""
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return

    import io, base64
    for n in plt.get_fignums():
        fig = plt.figure(n)
        if fig.get_axes():
            buf = io.BytesIO()
            fig.savefig(buf, format='png', bbox_inches='tight', dpi=100)
            buf.seek(0)
            b64 = base64.b64encode(buf.getvalue()).decode('ascii')
            buf.close()
            postOutput("image", b64)
    plt.close('all')

def _patched_show(*args, **kwargs):
    """Replacement for plt.show() — flushes text, then captures figures inline."""
    _stdout_capture.drain()
    _stderr_capture.drain()
    _capture_figures()

def _patch_plt_show():
    """Replace plt.show if matplotlib.pyplot is loaded. Safe to call anytime."""
    try:
        import matplotlib.pyplot as plt
        plt.show = _patched_show
    except ImportError:
        pass

def _start_capture():
    from io import StringIO
    _stdout_capture._buf = StringIO()
    _stderr_capture._buf = StringIO()
    sys.stdout = _stdout_capture
    sys.stderr = _stderr_capture

def _stop_capture():
    _stdout_capture.drain()
    _stderr_capture.drain()
    sys.stdout = _original_stdout
    sys.stderr = _original_stderr
`;

/**
 * Inject `_patch_plt_show()` after any line that imports matplotlib.pyplot.
 * This ensures plt.show is patched before user code calls it.
 */
function injectPltPatch(code) {
  const lines = code.split("\n");
  const result = [];
  // Match: import matplotlib.pyplot / from matplotlib.pyplot import ... / from matplotlib import pyplot
  const pattern =
    /^(\s*)(import\s+matplotlib\.pyplot|from\s+matplotlib\.pyplot\s+import|from\s+matplotlib\s+import\s+pyplot)/;

  for (const line of lines) {
    result.push(line);
    if (pattern.test(line)) {
      const indent = line.match(/^(\s*)/)[1];
      result.push(`${indent}_patch_plt_show()`);
    }
  }

  return result.join("\n");
}

async function loadPyodideInstance() {
  try {
    const pyodideModule =
      await import("https://cdn.jsdelivr.net/pyodide/v0.29.2/full/pyodide.mjs");
    pyodide = await pyodideModule.loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.2/full/",
    });

    if (settings.loadMicropip) {
      await pyodide.loadPackage("micropip");
    }

    let init_code = `
import sys
from io import StringIO
sys.stdout = StringIO()`;

    if (settings.loadMicropip) {
      init_code += "\nimport micropip";
      if (settings.libs.length > 0) {
        init_code += `\nawait micropip.install(${JSON.stringify(settings.libs)})`;
      }
    }

    await pyodide.runPythonAsync(init_code);
    pyodide.runPython(DISPLAY_SETUP);

    self.postMessage({ type: "ready" });
  } catch (error) {
    self.postMessage({
      type: "error",
      error: "Failed to load Pyodide: " + error.message,
    });
  }
}

async function runPython(code) {
  if (!pyodide) {
    self.postMessage({ type: "error", error: "Pyodide is not loaded yet" });
    return;
  }

  try {
    // If matplotlib was imported in a previous run, patch plt.show
    pyodide.runPython("_patch_plt_show()");

    pyodide.runPython("_start_capture()");

    // Inject _patch_plt_show() after matplotlib import lines
    const patchedCode = injectPltPatch(code);
    await pyodide.runPythonAsync(patchedCode);

    // Capture any figures left open (user forgot plt.show or didn't call it)
    pyodide.runPython(`
_stdout_capture.drain()
_stderr_capture.drain()
_capture_figures()
`);
    pyodide.runPython("_stop_capture()");

    self.postMessage({ type: "done" });
  } catch (error) {
    try {
      pyodide.runPython("_stop_capture()");
    } catch (e) {
      // ignore
    }

    self.postMessage({ type: "error", error: error.message });
  }
}

self.onmessage = async (event) => {
  const { type, code, settings: newSettings } = event.data;

  switch (type) {
    case "init":
      if (newSettings) {
        settings = { ...settings, ...newSettings };
      }
      loadPyodideInstance();
      break;

    case "run":
      await runPython(code);
      break;
  }
};
