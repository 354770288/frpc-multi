import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault('PROJECT_DIR',tempfile.mkdtemp(prefix='probe-jobs-env-'))
from app.probe.jobs import ProbeJobStore
from app.probe.store import ProbeStore, ServerPageQuery, DiscoverPageQuery
from app.probe.package import worker_bundle


class ProbeJobsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'console.db';self.store=ProbeJobStore(self.path)
        self.a=self.store.create_node('a')['id'];self.b=self.store.create_node('b')['id']
    def tearDown(self):self.tmp.cleanup()
    def job(self,mode='connectivity',nodes=None,ips=None,**kw):
        return self.store.create_job(mode,nodes or [self.a],ips=ips or ['192.0.2.1'],**kw)
    def finish(self,node,task,result=None,infra_error=None):
        return self.store.report(node,task['taskId'],task['attemptId'],result=result or {},infra_error=infra_error)
    def expire(self,task):
        with self.store._db() as c:c.execute('UPDATE probe_tasks SET lease_until=0 WHERE id=?',(task['taskId'],))
    def test_multi_node_every_target_isolated_and_port(self):
        self.job(nodes=[self.a,self.b],ips=['192.0.2.1','192.0.2.2'],port=7001)
        first=self.store.claim(self.a)
        parallel=self.store.claim(self.b);self.assertNotEqual(first['ip'],parallel['ip'])
        self.finish(self.b,parallel,{'frps_reachable':False})
        self.finish(self.a,first,{'frps_reachable':True})
        other=self.store.claim(self.b);self.finish(self.b,other,{'frps_reachable':False})
        self.assertTrue(self.store.latest_results(self.a,'connectivity')[0]['frps_reachable'])
        self.assertFalse(self.store.latest_results(self.b,'connectivity')[0]['frps_reachable'])
        self.assertEqual(self.store.latest_results(self.a,'connectivity')[0]['port'],7001)
    def test_latest_failure_overrides_success_then_ttl(self):
        self.job();t=self.store.claim(self.a);self.finish(self.a,t,{'frps_reachable':True})
        self.job();t=self.store.claim(self.a);self.finish(self.a,t,{'frps_reachable':False})
        self.assertFalse(self.store.latest_results(self.a,'connectivity')[0]['frps_reachable'])
        with self.store._db() as c:c.execute("UPDATE probe_results SET test_time='2000-01-01T00:00:00+00:00' WHERE task_id=?",(t['taskId'],))
        self.assertEqual(self.store.latest_results(self.a,'connectivity',86400),[])
    def test_lease_fencing_and_max_three_attempts(self):
        j=self.job();first=self.store.claim(self.a);self.expire(first)
        second=self.store.claim(self.a);self.assertNotEqual(first['attemptId'],second['attemptId'])
        self.assertFalse(self.finish(self.a,first)['applied'])
        self.finish(self.a,second,infra_error='network')
        third=self.store.claim(self.a);self.finish(self.a,third,infra_error='network')
        self.assertIsNone(self.store.claim(self.a));self.assertEqual(self.store.get_job(j['id'])['state'],'failed')
    def test_target_failure_no_retry_and_report_idempotent(self):
        self.job();t=self.store.claim(self.a);self.finish(self.a,t,{'frps_reachable':False})
        response=self.finish(self.a,t,{'frps_reachable':True});self.assertFalse(response['applied']);self.assertTrue(response['accepted'])
        self.assertIsNone(self.store.claim(self.a));self.assertEqual(len(self.store.history(self.a,'connectivity')),1)
    def test_heartbeat_renew_and_cancel_cleanup_holds_host_lock(self):
        j=self.job(nodes=[self.a,self.b]);t=self.store.claim(self.a)
        with self.store._db() as c:c.execute('UPDATE probe_tasks SET lease_until=lease_until-50 WHERE id=?',(t['taskId'],))
        self.store.heartbeat(self.a,'sha',['connectivity'],[{'taskId':t['taskId'],'attemptId':t['attemptId']}])
        self.store.action(j['id'],'skip',[t['taskId']])
        self.assertIsNone(self.store.claim(self.b))
        hb=self.store.heartbeat(self.a,'sha',['connectivity'],[{'taskId':t['taskId'],'attemptId':t['attemptId']}]);self.assertEqual(len(hb['cancelled']),1)
        self.finish(self.a,t,{'cancelled':True});self.assertIsNotNone(self.store.claim(self.b))
    def test_speed_exclusive_node_other_hosts_tunnel_exclusive_host(self):
        self.job('route',ips=['192.0.2.10']);route=self.store.claim(self.a)
        self.job('speed',ips=['192.0.2.2']);self.assertIsNone(self.store.claim(self.a))
        self.finish(self.a,route);speed=self.store.claim(self.a)
        self.job('route',ips=['192.0.2.3']);self.assertIsNone(self.store.claim(self.a));self.finish(self.a,speed)
        self.assertEqual(self.store.claim(self.a)['stage'],'route')
    def test_full_route_failure_continues_conn_failure_skips_speed(self):
        j=self.job('full');t=self.store.claim(self.a);self.finish(self.a,t,{'ok':False})
        t=self.store.claim(self.a);self.assertEqual(t['stage'],'connectivity');self.finish(self.a,t,{'frps_reachable':False})
        job=self.store.get_job(j['id']);self.assertEqual(job['counts'],{'failed':2,'skipped':1});self.assertIsNone(self.store.claim(self.a))
    def test_full_pass_speed(self):
        self.job('full');self.finish(self.a,self.store.claim(self.a),{'ok':False})
        self.finish(self.a,self.store.claim(self.a),{'frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        self.assertEqual(self.store.claim(self.a)['stage'],'speed')
    def test_scan_chunk_bounded_restart_unacked_and_seq_atomic(self):
        j=self.store.create_job('discover',[self.a],targets='10.0.0.1-10.0.39.16',auto_full=True,concurrency=20)
        task=self.store.claim(self.a);self.assertEqual(task['payload']['size'],4096)
        hit={'ip':'10.0.0.1','port':7000,'latencyMs':1.2}
        self.assertTrue(self.store.progress(self.a,task['taskId'],task['attemptId'],1,hits=[hit])['accepted'])
        self.store.progress(self.a,task['taskId'],task['attemptId'],1,hits=[hit])
        detail=self.store.get_job(j['id']);self.assertEqual(len(detail['tasks']),2)
        self.expire(task);reopened=ProbeJobStore(self.path);new=reopened.claim(self.a)
        self.assertEqual(new['payload']['cursor'],0)
        self.finish(self.a,new,{'scanned':4096})
        tasks=reopened.get_job(j['id'])['tasks'];self.assertEqual(sum(t['stage']=='discover' for t in tasks),2)
        self.assertTrue(any(t['payload'].get('cursor')==4096 for t in tasks))
        self.assertEqual(len(ProbeStore(self.path,node_id=self.a).query_discover_results(DiscoverPageQuery())['items']),1)
    def test_progress_validation_rolls_back_and_fencing(self):
        self.store.create_job('discover',[self.a],targets='192.0.2.1',auto_route=True)
        t=self.store.claim(self.a)
        with self.assertRaises(ValueError):self.store.progress(self.a,t['taskId'],t['attemptId'],1,hits=[{'ip':'192.0.2.1'},{'ip':'192.0.2.2'}])
        self.assertEqual(ProbeStore(self.path).query_discover_results(DiscoverPageQuery())['total'],0)
        self.assertFalse(self.store.progress(self.a,t['taskId'],'wrong',1)['accepted'])
    def test_retry_selected_and_empty_list_noop(self):
        j=self.job();t=self.store.claim(self.a);self.store.action(j['id'],'stop');self.finish(self.a,t)
        self.assertEqual(self.store.action(j['id'],'retry',[])['changed'],0)
        self.assertEqual(self.store.action(j['id'],'retry',[t['taskId']])['changed'],1)
        self.assertIsNotNone(self.store.claim(self.a))
    def test_legacy_nodes_migration_stable_deleted_not_resurrected_upgrade(self):
        path=Path(self.tmp.name)/'legacy.db';old=ProbeStore(path);old.set_setting('route_nodes',json.dumps([{'name':'legacy','token':'saved-token'}]))
        store=ProbeJobStore(path);node=store.authenticate('saved-token');self.assertEqual(node['capabilities'],['route'])
        self.assertEqual(ProbeJobStore(path).authenticate('saved-token')['id'],node['id'])
        store.heartbeat(node['id'],'new',['discover','route','connectivity','speed'],[]);self.assertEqual(store.get_node(node['id'])['kind'],'worker')
        store.delete_node(node['id']);self.assertEqual(len(ProbeJobStore(path).list_nodes()),1)
    def test_source_query_filters_and_speed_sort(self):
        assets=ProbeStore(self.path);assets.create_server(ip='192.0.2.1');assets.create_server(ip='192.0.2.2')
        self.job('speed',ips=['192.0.2.1','192.0.2.2']);t=self.store.claim(self.a);self.finish(self.a,t,{'dl_ok':True,'dl_speed_bps':1024*1024,'ul_speed_bps':2})
        t=self.store.claim(self.a);self.finish(self.a,t,{'dl_ok':False,'dl_speed_bps':0})
        a=ProbeStore(self.path,node_id=self.a).query_servers(ServerPageQuery(sort='speed',order='desc'))
        self.assertEqual(a['items'][0]['ip'],'192.0.2.1');self.assertEqual(a['items'][0]['s_dl_speed_mbps'],8)
        b=ProbeStore(self.path,node_id=self.b).query_servers(ServerPageQuery());self.assertIsNone(b['items'][0]['s_test_time'])
    def test_worker_bundle_uses_canonical_sources(self):
        self.assertEqual(worker_bundle(),worker_bundle())
        with tarfile.open(fileobj=io.BytesIO(worker_bundle())) as archive:
            self.assertEqual(archive.extractfile('app/probe/engine.py').read(),Path('app/probe/engine.py').read_bytes())
            self.assertEqual(archive.extractfile('app/probe/discover.py').read(),Path('app/probe/discover.py').read_bytes())


    def test_retry_preserves_gate_and_successful_downstream(self):
        j=self.job('full');route=self.store.claim(self.a);self.finish(self.a,route,{'ok':False})
        conn=self.store.claim(self.a);self.finish(self.a,conn,{'frps_reachable':False})
        speed=next(t for t in self.store.get_job(j['id'])['tasks'] if t['stage']=='speed')
        self.assertEqual(self.store.action(j['id'],'retry',[speed['taskId']])['changed'],0)
        self.store.action(j['id'],'retry',[conn['taskId']]);conn2=self.store.claim(self.a)
        self.finish(self.a,conn2,{'frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        speed2=self.store.claim(self.a);self.assertEqual(speed2['taskId'],speed['taskId'])
        self.finish(self.a,speed2,{'dl_ok':True,'ul_ok':True})
        self.store.action(j['id'],'retry',[route['taskId']]);route2=self.store.claim(self.a);self.finish(self.a,route2,{'ok':True})
        self.assertIsNone(self.store.claim(self.a))
        self.assertEqual(self.store.get_job(j['id'])['taskTotal'],3)
        self.assertEqual(len(self.store.history(self.a,'connectivity')),2)
    def test_parallel_connectivity_slots_and_paged_detail(self):
        j=self.job(ips=['192.0.2.1','192.0.2.2'])
        first=self.store.claim(self.a);second=self.store.claim(self.a)
        self.assertEqual(abs(first['options']['local_base_port']-second['options']['local_base_port']),3)
        page=self.store.get_job(j['id'],1,1);self.assertEqual(len(page['tasks']),1);self.assertEqual(page['taskTotal'],2)


    def test_endpoint_ports_not_mixed_in_asset_status(self):
        assets=ProbeStore(self.path)
        assets.create_server(ip='192.0.2.1');assets.create_server(ip='192.0.2.1:7001')
        self.job(ips=['192.0.2.1:7000','192.0.2.1:7001'])
        first=self.store.claim(self.a);self.finish(self.a,first,{'frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        second=self.store.claim(self.a);self.assertEqual(second['port'],7001);self.finish(self.a,second,{'frps_reachable':False})
        rows={r['ip']:r for r in ProbeStore(self.path,node_id=self.a).query_servers(ServerPageQuery())['items']}
        self.assertTrue(rows['192.0.2.1']['c_frps_reachable']);self.assertFalse(rows['192.0.2.1:7001']['c_frps_reachable'])
        self.assertEqual(len(self.store.latest_results(self.a,'connectivity')),2)


    def test_local_bind_and_nonexecutable_frpc_are_infrastructure(self):
        import socket
        from app.probe.executor import execute_task,InfrastructureError
        sock=socket.socket();sock.bind(('0.0.0.0',0));sock.listen(16)
        try:
            task={'stage':'connectivity','ip':'127.0.0.1','port':sock.getsockname()[1],'options':{'tcping_retries':1,'local_base_port':sock.getsockname()[1],'frpc_bin':'/bin/echo'}}
            with self.assertRaises(InfrastructureError):execute_task(task,lambda:False,lambda *a:None)
            bad=Path(self.tmp.name)/'bad-frpc';bad.write_text('bad');bad.chmod(0o600)
            task['options']['local_base_port']=0;task['options']['frpc_bin']=str(bad)
            with self.assertRaises(InfrastructureError):execute_task(task,lambda:False,lambda *a:None)
        finally:sock.close()
    def test_local_service_stop_closes_accepted_clients(self):
        import socket,time
        from app.probe.engine import LocalEchoServer
        service=LocalEchoServer(0);self.assertTrue(service.start()[0])
        client=socket.create_connection(('127.0.0.1',service.server_socket.getsockname()[1]));client.sendall(b'hello');self.assertEqual(client.recv(5),b'hello')
        service.stop();client.settimeout(1);self.assertEqual(client.recv(1),b'');client.close()
        self.assertFalse(service._clients);self.assertFalse(service._handlers)


    def test_config_snapshot_port_ranges_do_not_overlap(self):
        self.job(ips=['192.0.2.1'],options={'local_base_port':11564})
        first=self.store.claim(self.a)
        self.job(ips=['192.0.2.2','192.0.2.3'],options={'local_base_port':11561})
        second=self.store.claim(self.a);third=self.store.claim(self.a)
        ranges=[set(range(t['options']['local_base_port'],t['options']['local_base_port']+3)) for t in (first,second,third)]
        self.assertFalse(ranges[0]&ranges[1]);self.assertFalse(ranges[0]&ranges[2]);self.assertFalse(ranges[1]&ranges[2])


    def test_endpoint_aliases_no_duplicate_rows_and_latest_failed_dashboard(self):
        assets=ProbeStore(self.path)
        assets.create_server(ip='192.0.2.1');assets.create_server(ip='192.0.2.1:7000')
        self.job('speed');self.finish(self.a,self.store.claim(self.a),{'dl_ok':True,'ul_ok':True,'dl_speed_bps':1048576,'ul_speed_bps':1048576})
        source=ProbeStore(self.path,node_id=self.a)
        rows=source.query_servers(ServerPageQuery());self.assertEqual(rows['total'],2);self.assertEqual(len(rows['items']),2)
        self.assertEqual(source.dashboard()['speed']['avgDownloadMbps'],8)
        self.job('speed');self.finish(self.a,self.store.claim(self.a),{'dl_ok':False,'ul_ok':False})
        self.assertIsNone(source.dashboard()['speed']['avgDownloadMbps'])

    def test_stage_counts_cover_whole_job_independent_of_task_page(self):
        job = self.job(nodes=[self.a, self.b], ips=['192.0.2.1', '192.0.2.2', '192.0.2.3'])
        self.store.claim(self.a)
        detail = self.store.get_job(job['id'], page=1, page_size=1)
        self.assertEqual(len(detail['tasks']), 1)
        counts = detail['stageCounts']
        self.assertEqual(sum(row['count'] for row in counts), 6)
        self.assertEqual(sum(row['count'] for row in counts if row['nodeId'] == self.a), 3)
        self.assertEqual(sum(row['count'] for row in counts if row['nodeId'] == self.b), 3)
        self.assertEqual(sum(row['count'] for row in counts if row['state'] == 'running'), 1)
        self.assertTrue(all(row['stage'] == 'connectivity' for row in counts))


    def test_runtime_capabilities_require_dependencies(self):
        from app.probe.worker import runtime_capabilities
        with patch('app.probe.worker.shutil.which',return_value=None):
            self.assertEqual(runtime_capabilities('/missing/frpc'),['discover'])
            self.assertEqual(runtime_capabilities('/bin/echo'),['discover','connectivity','speed'])


    def test_legacy_console_results_keep_original_port_after_config_change(self):
        assets=ProbeStore(self.path);assets.create_server(ip='192.0.2.1')
        assets.update_config_overrides({'frps_port':7000})
        assets.add_connectivity_result({'server_ip':'192.0.2.1','frps_reachable':True,'tunnel_established':True,'firewall_open':True})
        self.assertTrue(ProbeStore(self.path,node_id='console').query_servers(ServerPageQuery())['items'][0]['c_frps_reachable'])
        assets.update_config_overrides({'frps_port':7001})
        rows=ProbeStore(self.path,node_id='console').query_servers(ServerPageQuery())['items']
        self.assertIsNone(rows[0]['c_test_time'])
        self.assertEqual(self.store.latest_results('console','connectivity')[0]['port'],7000)
    def test_worker_lease_loss_reports_infra_after_execution(self):
        import threading
        from app.probe.worker import Worker
        reports=[]
        worker=Worker(lambda path,payload:reports.append((path,payload)) or {'accepted':True})
        task={'taskId':'t','attemptId':'a'}
        entry={'task':task,'key':'t:a','renewed':0,'cancel':threading.Event()}
        worker.active[entry['key']]=entry
        with patch('app.probe.worker.time.monotonic',return_value=100),patch('app.probe.worker.execute_task',return_value={'cancelled':True}):worker._run(entry)
        self.assertEqual(reports[0][0],'report');self.assertIn('infraError',reports[0][1]);self.assertNotIn('result',reports[0][1])


    def test_preexisting_history_survives_migration_with_visible_snapshots(self):
        path=Path(self.tmp.name)/'historical.db';old=ProbeStore(path);old.create_server(ip='192.0.2.1')
        from app.control.database import connect_database
        c=connect_database(path)
        try:
            c.execute("INSERT INTO probe_connectivity_results(server_ip,frps_reachable,tunnel_established,firewall_open,test_time) VALUES('192.0.2.1',1,1,1,'2026-10-21T00:00:00+00:00')")
            c.execute("INSERT INTO probe_speed_results(server_ip,dl_ok,ul_ok,dl_speed_mbps,ul_speed_mbps,test_time) VALUES('192.0.2.1',1,1,8,4,'2026-10-21T00:00:00+00:00')")
            c.commit()
        finally:c.close()
        jobs=ProbeJobStore(path);source=ProbeStore(path,node_id='console')
        row=source.query_servers(ServerPageQuery())['items'][0]
        self.assertTrue(row['c_frps_reachable']);self.assertEqual(row['s_dl_speed_mbps'],8)
        self.assertEqual(len(jobs.history('console','connectivity')),1)
        self.assertEqual(source.dashboard()['speed']['avgDownloadMbps'],8)

    def test_source_page_uses_bounded_indexed_projection(self):
        import ipaddress
        from dataclasses import replace

        base = int(ipaddress.IPv4Address('198.18.0.1'))
        ips = [str(ipaddress.IPv4Address(base + i)) for i in range(300)]
        ProbeStore(self.path).import_servers([{'ip': ip} for ip in ips])
        with self.store._db() as c:
            c.executemany(
                'INSERT INTO probe_results(task_id,job_id,node_id,kind,server_ip,port,test_time,data) VALUES(?,?,?,?,?,?,?,?)',
                [(f'perf-{i}-{generation}', '', self.a, 'connectivity', ip, 7000,
                  '2026-10-21T00:00:00+00:00', json.dumps({'frps_reachable': generation != 3}))
                 for i, ip in enumerate(ips) for generation in range(4)],
            )

        class BudgetStore(ProbeStore):
            def _source_views(self, connection):
                steps = 0
                def budget():
                    nonlocal steps
                    steps += 1000
                    return steps > 500_000
                connection.set_progress_handler(budget, 1000)
                super()._source_views(connection)

        source = BudgetStore(self.path, node_id=self.a)
        page = source.query_servers(replace(ServerPageQuery(), page_size=1))
        self.assertEqual(page['total'], 300)
        self.assertEqual(len(page['items']), 1)
        self.assertFalse(page['items'][0]['c_frps_reachable'])
        self.assertEqual(len(source.list_connectivity_history(ip=ips[0])), 4)
        filtered = self.store.latest_results(self.a, 'connectivity', ips=ips[:1])
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]['server_ip'], ips[0])
        self.assertEqual(self.store.latest_results(self.a, 'connectivity', ips=[]), [])
