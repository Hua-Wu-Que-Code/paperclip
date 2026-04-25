import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ShortcutEntry {
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

const sections: ShortcutSection[] = [
  {
    title: "收件箱",
    shortcuts: [
      { keys: ["j"], label: "向下移动" },
      { keys: ["↓"], label: "向下移动" },
      { keys: ["k"], label: "向上移动" },
      { keys: ["↑"], label: "向上移动" },
      { keys: ["←"], label: "折叠所选分组" },
      { keys: ["→"], label: "展开所选分组" },
      { keys: ["Enter"], label: "打开所选项" },
      { keys: ["a"], label: "归档项目" },
      { keys: ["y"], label: "归档项目" },
      { keys: ["r"], label: "标记为已读" },
      { keys: ["U"], label: "标记为未读" },
    ],
  },
  {
    title: "事务详情",
    shortcuts: [
      { keys: ["y"], label: "快速归档回到收件箱" },
      { keys: ["g", "i"], label: "前往收件箱" },
      { keys: ["g", "c"], label: "聚焦评论输入框" },
    ],
  },
  {
    title: "全局",
    shortcuts: [
      { keys: ["/"], label: "搜索当前页面或快速搜索" },
      { keys: ["c"], label: "新建事务" },
      { keys: ["["], label: "切换侧边栏" },
      { keys: ["]"], label: "切换面板" },
      { keys: ["?"], label: "显示键盘快捷键" },
    ],
  },
];

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground shadow-[0_1px_0_1px_hsl(var(--border))]">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsCheatsheetContent() {
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-1.5">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label + shortcut.keys.join()}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-foreground/90">{shortcut.label}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && <span className="text-xs text-muted-foreground">然后</span>}
                        <KeyCap>{key}</KeyCap>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          Press <KeyCap>Esc</KeyCap> to close &middot; Shortcuts are disabled in text fields
        </p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">键盘快捷键</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
