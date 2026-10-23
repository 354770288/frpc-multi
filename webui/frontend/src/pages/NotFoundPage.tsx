import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';

export function NotFoundPage() {
  return <main className="mx-auto max-w-2xl px-6 py-16 text-center">
    <h2 className="text-xl font-semibold">页面不存在</h2>
    <p className="mt-2 text-sm text-muted-foreground">链接可能已更新。请从工作台重新选择入口。</p>
    <Button asChild className="mt-5"><Link to="/workspace">返回工作台</Link></Button>
  </main>;
}
