import prettyMs from "pretty-ms";
import prettyBytes from "pretty-bytes";
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { m } from "../../paraglide/messages.js";
import type { ValidationResult } from "../../worker/types";
import { columns, type Row as TableRow } from "./table";
import { VERDICT, verdictDetail, type RunKind } from "./verdict";
import type { PreparedReport, ReportFormat } from "./reports";

const { Text } = Typography;

interface ResultsCardProps {
  result: ValidationResult;
  runKind: RunKind;
  tokenColors: Record<string, string>;
  rows: TableRow[];
  reports: Record<ReportFormat, PreparedReport> | null;
  handleDownload: (fmt: ReportFormat) => void;
  wrapRawOutput: boolean;
  setWrapRawOutput: (value: boolean) => void;
}

export function ResultsCard({
  result,
  runKind,
  tokenColors,
  rows,
  reports,
  handleDownload,
  wrapRawOutput,
  setWrapRawOutput,
}: ResultsCardProps) {
  const verdict = VERDICT[result.verdict];
  return (
    <Card
      title={
        <Space>
          <Text strong>{result.name}</Text>
          {result.epubVersion && (
            <Tag color="blue">
              {m.epub_version_tag({ version: result.epubVersion })}
            </Tag>
          )}
        </Space>
      }
    >
      {/* Single verdict box — one colored box, three states; text + icon
          painted with the SAME theme token the severity tags use for text
          (green-7 / orange-7 / red-7), read live from the antd token. */}
      <Alert
        style={{ marginBottom: 16 }}
        type={verdict.type}
        showIcon
        icon={
          <span style={{ color: tokenColors[verdict.tokenKey] }}>
            {verdict.icon}
          </span>
        }
        message={
          <span style={{ color: tokenColors[verdict.tokenKey] }}>
            {verdict.word}. {verdictDetail(result.verdict, runKind)}
          </span>
        }
      />

      {/* All seven stats. Wide viewports (lg+) lay them out evenly on a
          single line via flex; narrower widths reflow to two rows (four
          then three at sm) and two-up on phones (xs). */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6} lg={{ flex: 1 }}>
          <Statistic title={m.stat_fatal()} value={result.counts.fatal} />
        </Col>
        <Col xs={12} sm={6} lg={{ flex: 1 }}>
          <Statistic title={m.stat_errors()} value={result.counts.error} />
        </Col>
        <Col xs={12} sm={6} lg={{ flex: 1 }}>
          <Statistic title={m.stat_warnings()} value={result.counts.warning} />
        </Col>
        <Col xs={12} sm={6} lg={{ flex: 1 }}>
          <Statistic title={m.stat_infos()} value={result.counts.info} />
        </Col>
        {/* Usage only appears with -u passed, so a non-zero count means the
            toggle was on for this run; show the tile only then, to keep the
            stats row uncluttered on every default (no -u) validation. */}
        {result.counts.usage > 0 && (
          <Col xs={12} sm={6} lg={{ flex: 1 }}>
            <Statistic title={m.stat_usage()} value={result.counts.usage} />
          </Col>
        )}
        <Col xs={12} sm={6} lg={{ flex: 1 }}>
          <Statistic title={m.stat_wall_time()} value={prettyMs(result.wallMs)} />
        </Col>
        <Col xs={12} sm={6} lg={{ flex: 1 }}>
          <Statistic
            title={m.stat_file_size()}
            value={prettyBytes(result.sizeBytes)}
          />
        </Col>
      </Row>

      {/* Official EPUBCheck report downloads. The JSON/XML/XMP documents are
          prerendered by the engine's writers when the run finished, so those
          clicks save instantly; the CLI/console report and the raw ReportData JSON
          have no engine writer, so they are rendered on demand from the run's
          report data (see EpubcheckDemo). Five equal columns on wide screens (even
          flex), two-up on tablets, full-width stacked buttons on phones. Each
          button names its own format. */}
      <Row gutter={[8, 8]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} lg={{ flex: 1 }}>
          <Button
            block
            icon={<DownloadOutlined />}
            disabled={!reports}
            onClick={() => handleDownload("json")}
          >
            {m.button_download_report({ format: "JSON" })}
          </Button>
        </Col>
        <Col xs={24} sm={12} lg={{ flex: 1 }}>
          <Button
            block
            icon={<DownloadOutlined />}
            disabled={!reports}
            onClick={() => handleDownload("xml")}
          >
            {m.button_download_report({ format: "XML" })}
          </Button>
        </Col>
        <Col xs={24} sm={12} lg={{ flex: 1 }}>
          <Button
            block
            icon={<DownloadOutlined />}
            disabled={!reports}
            onClick={() => handleDownload("xmp")}
          >
            {m.button_download_report({ format: "XMP" })}
          </Button>
        </Col>
        <Col xs={24} sm={12} lg={{ flex: 1 }}>
          <Button
            block
            icon={<DownloadOutlined />}
            disabled={!reports}
            onClick={() => handleDownload("console")}
          >
            {m.button_download_report({ format: "CLI" })}
          </Button>
        </Col>
        <Col xs={24} sm={12} lg={{ flex: 1 }}>
          <Button
            block
            icon={<DownloadOutlined />}
            disabled={!reports}
            onClick={() => handleDownload("raw")}
          >
            {m.button_download_report({ format: "Raw JSON" })}
          </Button>
        </Col>
      </Row>

      {rows.length > 0 && (
        <Table
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: true }}
        />
      )}

      <Collapse
        style={{ marginTop: 16 }}
        ghost
        items={[
          {
            key: "log",
            label: m.collapse_raw_output(),
            extra: (
              <Space
                size={6}
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: "default" }}
              >
                <Text type="secondary">{m.label_text_wrap()}</Text>
                <Switch
                  size="small"
                  checked={wrapRawOutput}
                  onChange={setWrapRawOutput}
                />
              </Space>
            ),
            children: (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: wrapRawOutput ? "pre-wrap" : "pre",
                  wordBreak: wrapRawOutput ? "break-word" : "normal",
                  fontSize: 12,
                  maxHeight: 320,
                  overflow: "auto",
                }}
              >
                {result.log.join("\n")}
              </pre>
            ),
          },
        ]}
      />
    </Card>
  );
}
