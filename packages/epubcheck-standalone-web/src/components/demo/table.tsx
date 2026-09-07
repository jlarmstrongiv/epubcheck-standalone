import { Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { m } from "../../paraglide/messages.js";
import type { Severity, ReportMessage } from "../../worker/types";
import { SEVERITY_COLOR } from "./constants";

const { Text } = Typography;

// A table row, normalized from the library's ReportMessage shape so the table
// renders identically whether the rows are streaming in live or come from the
// finished result. ReportMessage.path is already the in-book (container-relative)
// path -- no book-name prefix to strip -- and line/column are -1 when the message
// is not tied to a position.
export interface Row {
  key: number;
  severity: string;
  code: string;
  path: string | null;
  line: number | null;
  column: number | null;
  message: string;
}

export function toRow(msg: ReportMessage, key: number): Row {
  return {
    key,
    severity: msg.severity,
    code: msg.id,
    path: msg.path.length > 0 ? msg.path : null,
    line: msg.line >= 0 ? msg.line : null,
    column: msg.column >= 0 ? msg.column : null,
    message: msg.message ?? "",
  };
}

export const columns: ColumnsType<Row> = [
  {
    title: m.col_severity(),
    dataIndex: "severity",
    key: "severity",
    width: 110,
    render: (s: string) => (
      <Tag color={SEVERITY_COLOR[s as Severity] ?? "default"}>{s}</Tag>
    ),
    filters: (["FATAL", "ERROR", "WARNING", "INFO", "USAGE"] as Severity[]).map(
      (s) => ({ text: s, value: s }),
    ),
    onFilter: (value, record) => record.severity === value,
  },
  {
    title: m.col_code(),
    dataIndex: "code",
    key: "code",
    width: 110,
    render: (code: string) => <Text code>{code}</Text>,
  },
  {
    title: m.col_location(),
    key: "location",
    width: 220,
    render: (_, r) => (
      <Text type="secondary" style={{ fontFamily: "monospace", fontSize: 12 }}>
        {r.path ?? "-"}
        {r.line != null
          ? ` (${r.line}${r.column != null ? `:${r.column}` : ""})`
          : ""}
      </Text>
    ),
  },
  {
    title: m.col_message(),
    dataIndex: "message",
    key: "message",
  },
];
