export function MetricCard({
  icon,
  title,
  value,
  hint,
  tone = 'blue'
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
      {hint ? <p>{hint}</p> : null}
      <div className={`bar ${tone}`} />
    </div>
  );
}
