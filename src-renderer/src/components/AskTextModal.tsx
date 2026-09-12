import { useEffect, useState } from "react";
import { Button, Input, Modal } from "@ttqtt/liquid-glass-react";

/**
 * 文本输入弹窗。Electron 环境没有原生 prompt，
 * 新增账号、重命名都走这里。
 */
export function AskTextModal({
  open,
  title,
  label,
  placeholder = "",
  defaultValue = "",
  okText = "确定",
  onOk,
  onClose,
}: {
  open: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  okText?: string;
  onOk: (v: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);

  // 每次打开都重置为传入的默认值，避免残留上一次的输入
  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  const submit = async () => {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    try {
      await onOk(v);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      size="sm"
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="accent" size="sm" onClick={submit} loading={busy} disabled={!value.trim()}>
            {okText}
          </Button>
        </div>
      }
    >
      {label && (
        <div className="hint" style={{ marginBottom: 8 }}>
          {label}
        </div>
      )}
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onClose();
        }}
      />
    </Modal>
  );
}
