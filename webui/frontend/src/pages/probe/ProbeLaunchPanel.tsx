import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import type { GroupInfo, ProbeMode, TestNode } from '../../lib/types';
import { NodePicker, supports, MODE_NAMES } from './NodeControls';
export function ProbeLaunchPanel({
  nodes,
  selectedNodes,
  onNodes,
  selectedIps,
  groups,
  busy,
  onStart,
  onSettings,
  mode,
  onMode,
  scope,
  onScope,
  discoveryCount,
}: {
  nodes: TestNode[];
  selectedNodes: string[];
  onNodes: (ids: string[]) => void;
  selectedIps: string[];
  groups: GroupInfo[];
  busy: boolean;
  onStart: (mode: Exclude<ProbeMode, 'discover'>, scope: string) => Promise<boolean>;
  onSettings: () => void;
  mode: Exclude<ProbeMode, 'discover'>;
  onMode: (mode: Exclude<ProbeMode, 'discover'>) => void;
  scope: string;
  onScope: (scope: string) => void;
  discoveryCount: number;
}) {
  const valid =
    selectedNodes.length > 0 &&
    selectedNodes.every((id) => nodes.some((node) => node.id === id && supports(node, mode)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>启动测试</CardTitle>
        <CardDescription>
          手动启动一次测量。页面轮询、切换页面与 DNS 同步只读取现有结果。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="probe-mode">测试方式</FieldLabel>
            <Select
              value={mode}
              onValueChange={(value) => onMode(value as typeof mode)}
              disabled={busy}
            >
              <SelectTrigger id="probe-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(['full', 'route', 'connectivity', 'speed'] as const).map((item) => (
                    <SelectItem value={item} key={item}>
                      {MODE_NAMES[item]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="probe-scope">目标范围</FieldLabel>
            <Select value={scope} onValueChange={onScope} disabled={busy}>
              <SelectTrigger id="probe-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">全部服务器</SelectItem>
                  <SelectItem value="selected" disabled={!selectedIps.length}>
                    跨页勾选的服务器（{selectedIps.length}）
                  </SelectItem>
                  <SelectItem value="discover-selected" disabled={!discoveryCount}>
                    网段发现勾选目标（{discoveryCount}）
                  </SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.name} value={group.name}>
                      分组：{group.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <NodePicker
          nodes={nodes}
          selected={selectedNodes}
          onChange={onNodes}
          mode={mode}
          disabled={busy}
        />
        {!valid && (
          <p className="text-xs text-muted-foreground">
            请勾选至少一个具备当前测试全部能力的节点。切换测试方式后，请取消能力不足的已选节点。
          </p>
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          完整测试：路由 → 连通性 →
          速率；连通性全部通过才启动速率。单独速率测试同样先验证连通性。发现记录需手动导入服务器库。
        </p>
        <div className="flex gap-2">
          <Button
            disabled={
              busy ||
              !valid ||
              (scope === 'selected' && !selectedIps.length) ||
              (scope === 'discover-selected' && !discoveryCount)
            }
            onClick={() => onStart(mode, scope)}
          >
            {busy ? '提交中…' : `开始${MODE_NAMES[mode]}`}
          </Button>
          <Button variant="outline" onClick={onSettings}>
            测试设置
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
