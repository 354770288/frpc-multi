import type { ProbeMode, TestNode } from '../../lib/types';
import { Badge } from '../../components/ui/badge';
import { FieldSet, FieldLegend } from '../../components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';

export const MODE_NAMES: Record<ProbeMode, string> = {
  discover: '网段发现',
  route: '路由追踪',
  connectivity: '连通性',
  speed: '速率',
  full: '完整测试',
};
export function supports(node: TestNode, mode: ProbeMode, autoRoute = false, autoFull = false) {
  const needs =
    mode === 'full' || autoFull
      ? [...(mode === 'discover' ? ['discover'] : []), 'route', 'connectivity', 'speed']
      : [mode, ...(autoRoute ? ['route'] : [])];
  return needs.every((cap) => node.capabilities.includes(cap));
}
export function SourceSelect({
  nodes,
  value,
  onChange,
}: {
  nodes: TestNode[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-56" aria-label="观测来源">
        <SelectValue placeholder="选择观测来源" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {nodes.map((node) => (
            <SelectItem key={node.id} value={node.id}>
              {node.name}
              {node.id === 'console' ? ' · 主控' : ''}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function NodePicker({
  nodes,
  selected,
  onChange,
  mode,
  autoRoute,
  autoFull,
  disabled,
}: {
  nodes: TestNode[];
  selected: string[];
  onChange: (ids: string[]) => void;
  mode: ProbeMode;
  autoRoute?: boolean;
  autoFull?: boolean;
  disabled?: boolean;
}) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">执行节点（各节点分别运行完整目标）</FieldLegend>
      <div className="flex flex-col gap-2">
        {nodes.map((node) => {
          const capable = supports(node, mode, autoRoute, autoFull);
          return (
            <label
              key={node.id}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            >
              <input
                type="checkbox"
                className="size-3.5"
                checked={selected.includes(node.id)}
                disabled={disabled || (!capable && !selected.includes(node.id))}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, node.id]
                      : selected.filter((id) => id !== node.id),
                  )
                }
              />
              <span className="flex-1">{node.name}</span>
              <Badge tone={node.online ? 'success' : 'muted'}>
                {node.online ? '在线' : '离线 · 任务排队'}
              </Badge>
              {!capable && (
                <span className="text-muted-foreground">
                  {node.kind === 'legacy' ? '旧版仅路由，需升级' : '缺少所需能力'}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {nodes.length === 0 && (
        <p className="text-xs text-muted-foreground">节点加载中，请稍后重试。</p>
      )}
      {selected.some((id) => nodes.some((node) => node.id === id && !node.online)) && (
        <p className="text-xs text-muted-foreground">
          离线节点的任务保留在该节点，等待其上线；不会转派到其他来源。
        </p>
      )}
    </FieldSet>
  );
}
