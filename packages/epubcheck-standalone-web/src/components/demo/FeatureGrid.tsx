import { Card, Col, Row, Space, Typography } from "antd";
import { FEATURES } from "./constants";

const { Text } = Typography;

export function FeatureGrid() {
  return (
    /* Marketing bullets — nine short claims, strongest first, as a responsive
        card grid (1 / 2 / 3 columns as the viewport widens). Each claim wraps
        to as many lines as it needs so nothing overflows on a narrow card. */
    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
      {FEATURES.map((f) => (
        <Col key={f.text} xs={24} sm={12} lg={8}>
          <Card size="small" style={{ height: "100%" }}>
            <Space align="start" wrap={false}>
              <span style={{ fontSize: 20, lineHeight: 1 }}>{f.icon}</span>
              <Text>{f.text}</Text>
            </Space>
          </Card>
        </Col>
      ))}
    </Row>
  );
}
