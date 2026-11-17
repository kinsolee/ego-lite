// osascript -l JavaScript pasteboard.jxa.js save|restore|count <dir>
// Full-fidelity copy of the macOS general pasteboard: every item, every type.
ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  const [mode, dir] = argv;
  const pasteboard = $.NSPasteboard.generalPasteboard;
  if (mode === "count") return String(pasteboard.changeCount);
  if (mode === "save") {
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
    const items = pasteboard.pasteboardItems;
    const manifest = [];
    for (let i = 0; i < items.count; i++) {
      const item = items.objectAtIndex(i);
      const types = item.types;
      const entry = [];
      for (let k = 0; k < types.count; k++) {
        const type = ObjC.unwrap(types.objectAtIndex(k));
        const data = item.dataForType(type);
        if (!data || data.isNil()) continue;
        const file = dir + "/" + i + "_" + k;
        data.writeToFileAtomically(file, true);
        entry.push([type, file]);
      }
      manifest.push(entry);
    }
    $(JSON.stringify(manifest)).writeToFileAtomicallyEncodingError(dir + "/manifest.json", true, $.NSUTF8StringEncoding, $());
    return "saved " + manifest.length;
  }
  if (mode === "restore") {
    const text = $.NSString.stringWithContentsOfFileEncodingError(dir + "/manifest.json", $.NSUTF8StringEncoding, $());
    const manifest = JSON.parse(ObjC.unwrap(text));
    const objects = $.NSMutableArray.array;
    for (const entry of manifest) {
      const item = $.NSPasteboardItem.alloc.init;
      for (const [type, file] of entry) item.setDataForType($.NSData.dataWithContentsOfFile(file), type);
      objects.addObject(item);
    }
    pasteboard.clearContents;
    if (manifest.length) pasteboard.writeObjects(objects);
    return "restored " + manifest.length;
  }
  throw new Error("usage: save|restore|count <dir>");
}
