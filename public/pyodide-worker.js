// Pyodide Web Worker (Standalone)
let pyodide = null;
let settings = {
  loadMicropip: false,
  libs: [],
};

async function loadPyodideInstance() {
  try {
    const pyodideModule = await import(
      "https://cdn.jsdelivr.net/pyodide/v0.29.2/full/pyodide.mjs"
    );
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
    self.postMessage({
      type: "error",
      error: "Pyodide is not loaded yet",
    });
    return;
  }

  try {
    await pyodide.runPythonAsync(`
import sys
from io import StringIO
sys.stdout = StringIO()
    `);

    await pyodide.runPythonAsync(code);

    const stdout = await pyodide.runPythonAsync("sys.stdout.getvalue()");

    self.postMessage({
      type: "success",
      output: stdout || "Code executed successfully (no output)",
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error.message,
    });
  }
}

self.onmessage = async (event) => {
  const { type, code, settings: newSettings } = event.data;

  switch (type) {
    case "init":
      // Update settings before loading
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
