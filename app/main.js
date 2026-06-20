const state = {
  files: [],
  current: null,
  etag: null,
  savedContent: "",
  previewTimer: null,
  visualEditing: false,
  sourceVisible: false,
  syncingFromPreview: false
};

const els = {
  fileList: document.querySelector("#fileList"),
  searchInput: document.querySelector("#searchInput"),
  refreshBtn: document.querySelector("#refreshBtn"),
  currentPath: document.querySelector("#currentPath"),
  fileMeta: document.querySelector("#fileMeta"),
  saveBtn: document.querySelector("#saveBtn"),
  previewBtn: document.querySelector("#previewBtn"),
  visualEditBtn: document.querySelector("#visualEditBtn"),
  sourceToggleBtn: document.querySelector("#sourceToggleBtn"),
  emptyState: document.querySelector("#emptyState"),
  editorGrid: document.querySelector("#editorGrid"),
  editor: document.querySelector("#editor"),
  preview: document.querySelector("#preview"),
  dirtyState: document.querySelector("#dirtyState"),
  previewState: document.querySelector("#previewState"),
  toast: document.querySelector("#toast")
};

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2800);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function renderFiles() {
  const query = els.searchInput.value.trim().toLowerCase();
  const files = state.files.filter((file) => file.path.toLowerCase().includes(query));

  if (!files.length) {
    els.fileList.innerHTML = `<div class="file-item"><strong>没有找到 HTML 文件</strong><small>把文件复制到 content 目录后刷新</small></div>`;
    return;
  }

  els.fileList.innerHTML = "";
  for (const file of files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `file-item${state.current === file.path ? " active" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(file.name)}</strong>
      <small>${escapeHtml(file.path)} · ${formatSize(file.size)} · ${formatDate(file.modifiedAt)}</small>
    `;
    button.addEventListener("click", () => openFile(file.path));
    els.fileList.append(button);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadFiles() {
  const data = await requestJson("/api/files");
  state.files = data.files;
  renderFiles();
}

function setDirty() {
  const dirty = els.editor.value !== state.savedContent;
  els.saveBtn.disabled = !state.current || !dirty;
  els.dirtyState.textContent = dirty ? "有未保存修改" : "未修改";
  els.dirtyState.classList.toggle("is-dirty", dirty);
}

function setControlsEnabled(enabled) {
  els.previewBtn.disabled = !enabled;
  els.visualEditBtn.disabled = !enabled;
  els.sourceToggleBtn.disabled = !enabled;
}

function updateModeLabels() {
  els.visualEditBtn.textContent = state.visualEditing ? "退出编辑" : "预览编辑";
  els.visualEditBtn.classList.toggle("is-active", state.visualEditing);
  els.sourceToggleBtn.textContent = state.sourceVisible ? "隐藏源码" : "源码";
  els.sourceToggleBtn.classList.toggle("is-active", state.sourceVisible);
  els.editorGrid.classList.toggle("source-hidden", !state.sourceVisible);
}

function refreshPreview() {
  if (!state.current) return;
  state.visualEditing = false;
  els.preview.srcdoc = withPreviewBase(els.editor.value);
  els.previewState.textContent = `已刷新 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  updateModeLabels();
}

function schedulePreview() {
  if (state.syncingFromPreview) return;
  window.clearTimeout(state.previewTimer);
  state.previewTimer = window.setTimeout(refreshPreview, 450);
}

function getPreviewDocument() {
  return els.preview.contentDocument || els.preview.contentWindow?.document || null;
}

function getDocType(documentRef) {
  const doctype = documentRef.doctype;
  if (!doctype) return "<!doctype html>";
  const publicId = doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : "";
  const systemId = doctype.systemId ? ` "${doctype.systemId}"` : "";
  return `<!doctype ${doctype.name}${publicId}${systemId}>`;
}

function removeEditorHelpers(documentRef) {
  documentRef.querySelector("#html-cms-visual-style")?.remove();
  documentRef.querySelector("#html-cms-preview-base")?.remove();
  documentRef.body?.removeAttribute("contenteditable");
}

function contentBaseHref() {
  if (!state.current) return "/content/";
  const parts = state.current.split("/");
  parts.pop();
  const folder = parts.length ? `${parts.join("/")}/` : "";
  return `/content/${folder}`;
}

function withPreviewBase(html) {
  const parser = new DOMParser();
  const documentRef = parser.parseFromString(html, "text/html");
  const base = documentRef.createElement("base");
  base.id = "html-cms-preview-base";
  base.href = contentBaseHref();
  documentRef.head.prepend(base);
  return `${getDocType(documentRef)}\n${documentRef.documentElement.outerHTML}`;
}

function serializePreview() {
  const documentRef = getPreviewDocument();
  if (!documentRef || !documentRef.documentElement) return els.editor.value;

  const clone = documentRef.cloneNode(true);
  removeEditorHelpers(clone);
  return `${getDocType(clone)}\n${clone.documentElement.outerHTML}`;
}

function syncFromPreview() {
  state.syncingFromPreview = true;
  els.editor.value = serializePreview();
  setDirty();
  state.syncingFromPreview = false;
}

function enableVisualEditing() {
  const documentRef = getPreviewDocument();
  if (!documentRef || !documentRef.body) {
    toast("预览还没有加载完成，请稍后再试");
    return;
  }

  state.visualEditing = true;
  removeEditorHelpers(documentRef);
  documentRef.body.setAttribute("contenteditable", "true");

  const style = documentRef.createElement("style");
  style.id = "html-cms-visual-style";
  style.textContent = `
    body[contenteditable="true"] {
      cursor: text;
    }
    body[contenteditable="true"] *:hover {
      outline: 1px dashed rgba(22, 122, 117, 0.55);
      outline-offset: 2px;
    }
    body[contenteditable="true"] *:focus {
      outline: 2px solid rgba(22, 122, 117, 0.9);
      outline-offset: 2px;
    }
  `;
  documentRef.head?.append(style);

  documentRef.addEventListener("input", syncFromPreview);
  documentRef.addEventListener("keyup", syncFromPreview);
  documentRef.addEventListener("paste", syncFromPreviewSoon);
  els.previewState.textContent = "正在编辑预览中的文字";
  updateModeLabels();
  toast("可以直接点击预览里的文字修改");
}

function syncFromPreviewSoon() {
  window.setTimeout(syncFromPreview, 0);
}

function disableVisualEditing() {
  const documentRef = getPreviewDocument();
  if (documentRef) {
    syncFromPreview();
    removeEditorHelpers(documentRef);
  }
  state.visualEditing = false;
  els.previewState.textContent = "预览编辑已关闭";
  updateModeLabels();
}

function toggleVisualEditing() {
  if (!state.current) return;
  if (state.visualEditing) {
    disableVisualEditing();
  } else {
    enableVisualEditing();
  }
}

async function openFile(filePath) {
  if (state.current && els.editor.value !== state.savedContent) {
    const proceed = window.confirm("当前文件有未保存修改，确定要切换文件吗？");
    if (!proceed) return;
  }

  const data = await requestJson(`/api/file?path=${encodeURIComponent(filePath)}`);
  state.current = data.path;
  state.etag = data.etag;
  state.savedContent = data.content;
  state.visualEditing = false;
  els.editor.value = data.content;
  els.currentPath.textContent = data.path;
  els.fileMeta.textContent = `最后修改：${formatDate(data.modifiedAt)}`;
  els.emptyState.classList.add("hidden");
  els.editorGrid.classList.remove("hidden");
  setControlsEnabled(true);
  setDirty();
  refreshPreview();
  renderFiles();
}

async function saveFile(force = false) {
  if (!state.current) return;
  if (state.visualEditing) syncFromPreview();

  try {
    const data = await requestJson("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: state.current,
        content: els.editor.value,
        etag: state.etag,
        force
      })
    });

    state.etag = data.etag;
    state.savedContent = els.editor.value;
    setDirty();
    await loadFiles();
    toast(`已保存，备份：${data.backup}`);
  } catch (error) {
    if (error.status === 409) {
      const overwrite = window.confirm("磁盘上的文件在你打开后被修改过。是否仍然覆盖保存？");
      if (overwrite) await saveFile(true);
      return;
    }
    toast(error.message);
  }
}

els.searchInput.addEventListener("input", renderFiles);
els.refreshBtn.addEventListener("click", () => loadFiles().then(() => toast("文件列表已刷新")).catch((error) => toast(error.message)));
els.previewBtn.addEventListener("click", refreshPreview);
els.visualEditBtn.addEventListener("click", toggleVisualEditing);
els.sourceToggleBtn.addEventListener("click", () => {
  state.sourceVisible = !state.sourceVisible;
  updateModeLabels();
});
els.saveBtn.addEventListener("click", () => saveFile());
els.editor.addEventListener("input", () => {
  setDirty();
  schedulePreview();
});
els.preview.addEventListener("load", () => {
  if (state.current && state.visualEditing) enableVisualEditing();
});

window.addEventListener("beforeunload", (event) => {
  if (els.editor.value !== state.savedContent) {
    event.preventDefault();
    event.returnValue = "";
  }
});

updateModeLabels();
loadFiles().catch((error) => toast(error.message));
