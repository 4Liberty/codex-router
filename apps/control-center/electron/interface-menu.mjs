// UI language affects native menus only; it never changes router configuration.
export function interfaceMenuTemplates(language, { showWindow, quit }) {
  const zh = language === "zh-CN";
  const traditional = language === "zh-TW";
  const labels = {
    "Open Control Center": "開啟控制中心", "Quit Codex Router": "結束 Codex Router",
    "About Codex Router": "關於 Codex Router", "Services": "服務", "Hide Codex Router": "隱藏 Codex Router",
    "Hide Others": "隱藏其他應用程式", "Show All": "顯示全部", "File": "檔案", "Close Window": "關閉視窗",
    "Edit": "編輯", "Undo": "復原", "Redo": "重做", "Cut": "剪下", "Copy": "複製", "Paste": "貼上",
    "Select All": "全選", "View": "顯示方式", "Reload": "重新載入", "Force Reload": "強制重新載入",
    "Toggle Developer Tools": "切換開發人員工具", "Actual Size": "實際大小", "Zoom In": "放大", "Zoom Out": "縮小",
    "Toggle Full Screen": "切換全螢幕", "Window": "視窗", "Minimize": "最小化", "Zoom": "縮放",
    "Bring All to Front": "將所有視窗移至最前方", "Help": "輔助說明",
  };
  const label = (english, chinese) => traditional ? labels[english] ?? english : zh ? chinese : english;
  const tray = [
    { label: label("Open Control Center", "打开控制中心"), click: showWindow },
    { type: "separator" },
    { label: label("Quit Codex Router", "退出 Codex Router"), click: quit },
  ];
  const application = [
    { label: "Codex Router", submenu: [
      { role: "about", label: label("About Codex Router", "关于 Codex Router") },
      { type: "separator" },
      { role: "services", label: label("Services", "服务") },
      { type: "separator" },
      { role: "hide", label: label("Hide Codex Router", "隐藏 Codex Router") },
      { role: "hideOthers", label: label("Hide Others", "隐藏其他应用") },
      { role: "unhide", label: label("Show All", "显示全部") },
      { type: "separator" },
      { role: "quit", label: label("Quit Codex Router", "退出 Codex Router") },
    ] },
    { label: label("File", "文件"), submenu: [
      { role: "close", label: label("Close Window", "关闭窗口") },
    ] },
    { label: label("Edit", "编辑"), submenu: [
      { role: "undo", label: label("Undo", "撤销") },
      { role: "redo", label: label("Redo", "重做") },
      { type: "separator" },
      { role: "cut", label: label("Cut", "剪切") },
      { role: "copy", label: label("Copy", "复制") },
      { role: "paste", label: label("Paste", "粘贴") },
      { role: "selectAll", label: label("Select All", "全选") },
    ] },
    { label: label("View", "显示"), submenu: [
      { role: "reload", label: label("Reload", "重新加载") },
      { role: "forceReload", label: label("Force Reload", "强制重新加载") },
      { role: "toggleDevTools", label: label("Toggle Developer Tools", "切换开发者工具") },
      { type: "separator" },
      { role: "resetZoom", label: label("Actual Size", "实际大小") },
      { role: "zoomIn", label: label("Zoom In", "放大") },
      { role: "zoomOut", label: label("Zoom Out", "缩小") },
      { role: "togglefullscreen", label: label("Toggle Full Screen", "切换全屏") },
    ] },
    { label: label("Window", "窗口"), submenu: [
      { role: "minimize", label: label("Minimize", "最小化") },
      { role: "zoom", label: label("Zoom", "缩放") },
      { label: label("Open Control Center", "打开控制中心"), click: showWindow },
      { role: "front", label: label("Bring All to Front", "前置全部窗口") },
      { role: "close", label: label("Close Window", "关闭窗口") },
    ] },
    { role: "help", label: label("Help", "帮助"), submenu: [] },
  ];
  return { tray, application };
}

export function isInterfaceLanguage(value) {
  return ["en", "zh-CN", "zh-TW", "ar", "hi", "ja", "ko", "es"].includes(value);
}

export function initialInterfaceLanguage(locale) {
  const parts = String(locale ?? "").toLowerCase().replaceAll("_", "-").split("-");
  if (parts[0] !== "zh") return "en";
  if (parts.includes("hant")) return "zh-TW";
  if (parts.includes("hans")) return "zh-CN";
  return parts.some((part) => ["tw", "hk", "mo"].includes(part)) ? "zh-TW" : "zh-CN";
}
