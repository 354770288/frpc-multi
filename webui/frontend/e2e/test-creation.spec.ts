import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('frpc-webui-auth', JSON.stringify({ token: 'local-fixture', username: 'qa', expiresAt: Date.now()/1000+3600 })));
  await page.route('**/api/**', async (route) => {
    const url=new URL(route.request().url());
    const json=(value:unknown)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
    if(url.pathname==='/api/probe/nodes')return json({items:[
      {id:'console',name:'Console',kind:'console',version:'qa',capabilities:['discover','route','connectivity','speed'],online:true},
      {id:'remote',name:'国内测试节点',kind:'worker',version:'qa',capabilities:['discover','route','connectivity','speed'],protocolFeatures:['task-generation-v1'],online:true},
      {id:'backup',name:'备用测试节点',kind:'worker',version:'qa',capabilities:['discover','route','connectivity','speed'],online:true},
      {id:'backup2',name:'第二备用节点',kind:'worker',version:'qa',capabilities:['discover','route','connectivity','speed'],protocolFeatures:['task-generation-v1'],online:true},
    ]});
    if(url.pathname==='/api/probe/nodes/execution-policy')return json({configured:true,primaryNodeId:'remote',backupNodeIds:['backup','backup2','console'],suggestedPrimaryNodeId:'remote'});
    if(url.pathname==='/api/probe/nodes/failovers'){
      const page=Number(url.searchParams.get('page') || 1);
      return json({items:[{id:page,taskId:`task-${page}`,jobId:'job-qa',fromNodeId:'remote',toNodeId:'backup',generation:page,reason:'primary_offline',transferredAt:'2026-10-23T10:00:00+00:00'}],page,pageSize:20,total:21});
    }
    if(url.pathname==='/api/probe/servers/groups')return json([{id:'group-qa',name:'QA',color:''},{id:'group-west',name:'West',color:''}]);
    if(url.pathname==='/api/probe/server-views')return json({items:[]});
    if(url.pathname==='/api/probe/server-selections' && route.request().method()==='POST'){
      const body=route.request().postDataJSON() as {group?:string};
      const count=body.group==='QA' ? 1 : 120;
      const now=new Date().toISOString();
      return json({selectionId:body.group==='QA'?'group-selection':'all-selection',state:'ready',count,processed:count,createdAt:now,updatedAt:now,expiresAt:new Date(Date.now()+86400000).toISOString(),error:null});
    }
    if(url.pathname.startsWith('/api/probe/server-selections/')){
      const now=new Date().toISOString();
      const selectionId=url.pathname.split('/').pop() || '';
      const count=selectionId==='all-selection' ? 120 : selectionId==='group-selection' ? 1 : 2;
      return json({selectionId,state:'ready',count,processed:count,createdAt:now,updatedAt:now,expiresAt:new Date(Date.now()+86400000).toISOString(),error:null});
    }
    if(url.pathname==='/api/probe/tags/categories')return json({items:[{id:'region',name:'地区'},{id:'carrier',name:'线路'}]});
    if(url.pathname==='/api/probe/tags')return json({items:[{id:'tag-region-cn',categoryId:'region',category:'地区',name:'CN',serverCount:1},{id:'tag-carrier-cn',categoryId:'carrier',category:'线路',name:'CN',serverCount:1}]});
    if(url.pathname==='/api/probe/servers/facets')return json({labels:[{label:'legacy',count:1}],tagItems:[{tagId:'tag-region-cn',categoryId:'region',category:'地区',name:'CN',count:1},{tagId:'tag-carrier-cn',categoryId:'carrier',category:'线路',name:'CN',count:1}],groups:[],tagPage:Number(url.searchParams.get('tagPage') || 1),tagPageSize:Number(url.searchParams.get('tagPageSize') || 50),tagTotal:2});
    if(url.pathname==='/api/probe/servers/count'){
      if(url.searchParams.get('tagId')==='tag-carrier-cn'){
        await new Promise((resolve)=>setTimeout(resolve,900));
        return json({total:77});
      }
      if(url.searchParams.get('tagId')==='tag-region-cn')return json({total:88});
      if(url.searchParams.get('q')==='qa-count-failure' || url.searchParams.get('q')==='qa-page-failure')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'count fixture failure'})});
      return json({total:120});
    }
    if(url.pathname==='/api/probe/discover/results')return json({items:[{id:7,ip:'192.0.2.7',port:7000,latencyMs:8,nodeId:'remote',nodeName:'国内测试节点',group:'QA',labels:[],inLibrary:false,discoveredAt:'2026-10-23T10:00:00+00:00',latestRoute:null}],page:1,pageSize:50,total:1,sort:'discoveredAt',order:'desc'});
    if(url.pathname==='/api/probe/discover/facets')return json({labels:[],groups:[],imported:0,new:0});
    if(url.pathname==='/api/probe/dashboard')return json({servers:2,connectivity:{tested:1,reachable:1,tunnels:1,firewallOpen:1},speed:{tested:1,avgDownloadMbps:0,avgUploadMbps:0,maxDownloadMbps:0}});
    if(url.pathname==='/api/probe/config')return json({frpsPort:7000});
    if(url.pathname==='/api/probe/servers'){
      const entries=[{id:1,ip:'192.0.2.1:7000',port:7000},{id:2,ip:'192.0.2.2',port:7000}];
      const items=(url.searchParams.get('group')==='QA' ? entries.slice(0,1) : entries).map((item)=>({...item,nodeId:url.searchParams.get('nodeId') || 'console',nodeName:'QA',group:'QA',labels:[],createdAt:new Date().toISOString(),latestConnectivity:null,latestSpeed:null,latestRoute:null}));
      return json({items,page:Number(url.searchParams.get('page') || 1),pageSize:Number(url.searchParams.get('pageSize') || 200),total:url.searchParams.get('page')==='2' ? 120 : items.length,sort:'ip',order:'asc'});
    }
    if(url.pathname==='/api/probe/servers/cursor'){
      if(url.searchParams.get('q')==='qa-page-failure')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'page fixture failure'})});
      const entries=[{id:1,ip:'192.0.2.1:7000',port:7000},{id:2,ip:'192.0.2.2',port:7000}];
      const isSecond=url.searchParams.get('cursor')==='cursor-page2';
      const item=entries[isSecond ? 1 : 0];
      const value={...item,nodeId:'console',nodeName:'QA',group:'QA',labels:[],createdAt:new Date().toISOString(),latestConnectivity:null,latestSpeed:null,latestRoute:null};
      return json({items:[value],nextCursor:isSecond ? null : 'cursor-page2',hasMore:!isSecond});
    }
    if(url.pathname==='/api/probe/history/route/page')return json({items:[{id:1,node_id:'remote',server_ip:'192.0.2.1',port:7000,test_time:'2026-10-23T10:00:00+00:00',ok:true,isCn2:false,hops:[],error:''}],page:1,pageSize:50,total:205});
    if(url.pathname==='/api/probe/history/connectivity/page')return json({items:[],page:1,pageSize:50,total:0});
    if(url.pathname==='/api/audit-logs/page')return json({items:[{id:1,username:'qa',action:'review',nodeId:null,instanceName:null,success:true,message:'老记录',createdAt:'2025-01-01T00:00:00+00:00'}],page:1,pageSize:50,total:205});
    const deploymentNode={id:1,name:'部署节点 QA',uuid:'qa-node',status:'online',online:true,lastSeenAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const instance={name:'demo',displayName:'demo',enabled:true,description:'',configPath:'/tmp/demo/frpc.toml',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nodeId:1,nodeName:'部署节点 QA'};
    if(url.pathname==='/api/nodes')return json([deploymentNode]);
    if(url.pathname==='/api/summary')return json({total:1,running:1,stopped:0,error:0,nodes:[{...deploymentNode,total:1,running:1,stopped:0,errorCount:0}],instances:[{...instance,runtime:{}}],dockerAvailable:true,dockerError:''});
    if(url.pathname==='/api/nodes/1/instances/demo/config' && route.request().method()==='GET')return json({configText:'serverAddr = "qa.example.com"\nserverPort = 7000\n\n[[proxies]]\nname = "ssh"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 22\nremotePort = 7001\n',validation:{valid:true,errors:[],warnings:[],summary:{serverAddr:'qa.example.com',serverPort:7000,proxyCount:1,proxyTypes:{tcp:1},remotePorts:[7001]}}});
    if(url.pathname==='/api/nodes/1/instances/demo/config/validate')return json({valid:true,errors:[],warnings:[],summary:{serverAddr:'qa.example.com',serverPort:7000,proxyCount:1,proxyTypes:{tcp:1},remotePorts:[7001]}});
    if(url.pathname==='/api/nodes/1/instances/demo')return json({...instance,summary:{serverAddr:'qa.example.com',serverPort:7000,proxyCount:1,proxyTypes:{tcp:1},remotePorts:[7001]},warnings:[],errors:[]});
    if(url.pathname==='/api/nodes/1/system')return json({});
    if(url.pathname==='/api/console-info')return json({version:'qa',webuiHost:'localhost',webuiPort:5184,projectDir:'fixture',role:'console',username:'qa',nodeCount:0});
    if(url.pathname==='/api/lb/cloudflare')return json({configured:true,tokenMasked:'qa…token'});
    if(url.pathname==='/api/lb/selection-config')return json({nodeId:'remote',maxAgeHours:24,healthSource:'console'});
    if(url.pathname==='/api/lb/domains')return json([{id:1,name:'qa.example.com',zoneId:'z',zoneName:'example.com',group:'QA',ttl:60,syncMode:'manual',intervalSeconds:300,enabled:true,lastSyncAt:null,lastSyncOk:null,lastSyncMessage:'',currentIp:'192.0.2.1',createdAt:new Date().toISOString(),poolSize:1}]);
    if(url.pathname==='/api/lb/health')return json({states:[],domains:[{domainId:1,name:'qa.example.com',group:'QA',currentIp:'192.0.2.1',bestIp:'192.0.2.1',poolIps:['192.0.2.1'],selection:{nodeId:'remote',healthSource:'console',maxAgeHours:24,observedAt:null,validCandidates:0,bestIp:'192.0.2.1',reason:'keep_healthy_current'}}]});
    if(url.pathname==='/api/probe/jobs' && route.request().method()==='POST')return json({id:'created-qa-job',mode:'full',state:'running',counts:{pending:3},taskTotal:3,nodeIds:['remote'],stageCounts:[],progress:{scanned:0,foundCount:0},createdAt:new Date().toISOString(),tasks:[],page:1,pageSize:200});
    if(url.pathname==='/api/probe/jobs')return json({items:[],page:1,pageSize:20,total:0});
    if(url.pathname==='/api/probe/jobs/created-qa-job')return json({id:'created-qa-job',mode:'full',state:'running',counts:{pending:3},taskTotal:3,targetTotal:120,targetMaterialized:8,targetRemaining:112,targetProducer:{state:'running',nodeId:'remote',generation:0,failoverWaiting:true,error:''},filteredTaskTotal:3,nodeIds:['remote'],stageCounts:[],progress:{scanned:0,foundCount:0},createdAt:new Date().toISOString(),tasks:[],page:1,pageSize:200});
    return json({});
  });
});

test('new test requires an explicit target and review before submitting', async ({page}) => {
  let submissions=0;let submitted:Record<string,unknown>|null=null;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST'){submissions++;submitted=request.postDataJSON();}});
  await page.goto('/tests/new');
  await expect(page.getByRole('heading',{name:'新建测试',level:2})).toBeVisible();
  await expect(page.getByRole('button',{name:'下一步'})).toBeDisabled();
  expect(submissions).toBe(0);
  await page.getByLabel('目标范围').selectOption('group');
  await page.getByLabel('分组').selectOption('QA');
  await expect(page.getByText(/冻结快照目标：1 台/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await expect(page.getByText(/主节点：国内测试节点/)).toBeVisible();
  await expect(page.getByText(/备用节点顺序：备用测试节点/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await expect(page.getByText('目标：1 台冻结快照 · 分组 QA')).toBeVisible();
  expect(submissions).toBe(0);
  await page.getByRole('button',{name:'提交测试'}).click();
  await expect(page).toHaveURL(/\/tests\/created-qa-job/);
  expect(submissions).toBe(1);
  expect(submitted).toMatchObject({mode:'full',targetScope:'selection',selectionId:'group-selection',idempotencyKey:expect.any(String)});
  expect(submitted).not.toHaveProperty('ips');
  expect(submitted).not.toHaveProperty('nodeIds');
});

test('frozen server snapshot deep link shows count and submits by selection ID only', async ({page})=>{
  let submitted:Record<string,unknown>|null=null;
  const assetPageRequests:string[]=[];
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(['/api/probe/servers','/api/probe/servers/cursor'].includes(url.pathname) && new URL(page.url()).pathname==='/tests/new')assetPageRequests.push(url.pathname);
    if(url.pathname==='/api/probe/jobs' && request.method()==='POST')submitted=request.postDataJSON();
  });
  await page.goto('/servers');
  await page.getByRole('button',{name:/冻结全部匹配/}).click();
  await expect(page.getByLabel('服务器选择快照').getByText('冻结快照 120 台')).toBeVisible();
  await page.getByRole('button',{name:'创建测试任务'}).click();
  await expect(page).toHaveURL(/\/tests\/new\?selectionId=all-selection/);
  await expect(page.getByText(/冻结快照目标：120 台/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await page.getByRole('button',{name:'下一步'}).click();
  await page.getByRole('button',{name:'提交测试'}).click();
  await expect(page).toHaveURL(/\/tests\/created-qa-job/);
  expect(submitted).toMatchObject({mode:'full',targetScope:'selection',selectionId:'all-selection',idempotencyKey:expect.any(String)});
  expect(submitted).not.toHaveProperty('ips');
  expect(submitted).not.toHaveProperty('nodeIds');
  await expect(page.getByText('等待备用节点接管 · 目标物化 8/120 · 剩余 112')).toBeVisible();
  expect(assetPageRequests).toEqual([]);
});

test('selection submission keeps its idempotency key after an uncertain response and reload',async ({page})=>{
  const submissions:Record<string,unknown>[]=[];
  await page.route('**/api/probe/jobs',async (route)=>{
    if(route.request().method()!=='POST')return route.fallback();
    submissions.push(route.request().postDataJSON());
    if(submissions.length===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'temporary submit failure'})});
    return route.fallback();
  });
  await page.goto('/tests/new?selectionId=retry-selection');
  await expect(page.getByText(/冻结快照目标：2 台/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await page.getByLabel('测试方式').selectOption('speed');
  await page.getByRole('button',{name:'下一步'}).click();
  await page.getByRole('button',{name:'提交测试'}).click();
  await expect(page.getByText('temporary submit failure')).toBeVisible();
  expect(submissions).toHaveLength(1);
  await page.reload();
  await expect(page.getByText(/冻结快照目标：2 台/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await expect(page.getByLabel('测试方式')).toHaveValue('speed');
  await page.getByRole('button',{name:'下一步'}).click();
  await page.getByRole('button',{name:'提交测试'}).click();
  await expect(page).toHaveURL(/\/tests\/created-qa-job/);
  expect(submissions).toHaveLength(2);
  expect(submissions[0].idempotencyKey).toBe(submissions[1].idempotencyKey);
  expect(submissions[1]).toMatchObject({mode:'speed',targetScope:'selection',selectionId:'retry-selection'});
});

test('server views save stable filters and columns, restore query state, rename, and delete', async ({page}) => {
  const views: Record<string, any>[] = [];
  let createdPayload: Record<string, any> | null = null;
  await page.route('**/api/probe/server-views**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: views }) });
    if (request.method() === 'POST') {
      createdPayload = request.postDataJSON();
      const view = { id: 'saved-view-1', ...createdPayload, createdAt: 'now', updatedAt: 'now' };
      views.push(view);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) });
    }
    if (request.method() === 'PATCH') {
      const view = views[0];
      Object.assign(view, request.postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) });
    }
    if (request.method() === 'DELETE') {
      views.splice(0, 1);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fallback();
  });

  await page.goto('/servers?page=3&pageSize=25&cursor=do-not-save&q=seed-query&groupIds=group-qa&includeTagIds=tag-region-cn&excludeTagIds=tag-carrier-cn&tagMode=all&sort=group&order=desc');
  await expect(page.getByPlaceholder('搜索 IP / 标签 / 分组')).toHaveValue('seed-query');
  await expect(page).toHaveURL(/q=seed-query/);
  await page.getByLabel('新视图名称').fill('线路分组');
  await page.getByLabel('显示列 路由').uncheck();
  await page.getByRole('button', { name: '保存当前视图' }).click();
  await expect(page.getByLabel('加载保存视图')).toContainText('线路分组');
  expect(createdPayload).toMatchObject({
    name: '线路分组',
    filters: { q: 'seed-query', groupIds: ['group-qa'], includeTagIds: ['tag-region-cn'], excludeTagIds: ['tag-carrier-cn'], tagMode: 'all' },
    sort: 'group', order: 'desc',
  });
  expect(createdPayload?.visibleColumns).not.toContain('route');
  expect(createdPayload).not.toHaveProperty('page');
  expect(createdPayload).not.toHaveProperty('cursor');

  await page.goto('/servers?page=4&sort=ip&order=asc&q=elsewhere');
  await page.getByLabel('加载保存视图').click();
  await page.getByRole('option', { name: '线路分组' }).click();
  await expect(page).toHaveURL(/groupIds=group-qa/);
  await expect(page).toHaveURL(/includeTagIds=tag-region-cn/);
  await expect(page).toHaveURL(/excludeTagIds=tag-carrier-cn/);
  await expect(page).toHaveURL(/q=seed-query/);
  await expect(page).toHaveURL(/tagMode=all/);
  await expect(page).toHaveURL(/sort=group/);
  await expect(page).toHaveURL(/order=desc/);
  await expect(page).toHaveURL(/page=1/);
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.getByLabel('显示列 路由')).not.toBeChecked();

  await page.getByRole('button', { name: '重命名' }).click();
  await page.getByLabel('视图新名称').fill('核心线路');
  await page.getByRole('button', { name: '确认重命名' }).click();
  await expect(page.getByLabel('加载保存视图')).toContainText('核心线路');
  await page.getByRole('button', { name: '删除视图' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除视图' }).click();
  await expect(page.getByLabel('加载保存视图')).toContainText('当前筛选');
  expect(views).toHaveLength(0);
});

test('server view CRUD locks pending actions and ignores a stale list response', async ({page}) => {
  await page.addInitScript(() => {
    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, timeout === 300 ? 10_000 : timeout, ...args)) as typeof window.setTimeout;
  });
  let releaseList!: () => void;
  let releaseCreate!: () => void;
  let releaseRename!: () => void;
  let releaseDelete!: () => void;
  let listStarted!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const listStartedGate = new Promise<void>((resolve) => { listStarted = resolve; });
  let postCount = 0;
  let patchCount = 0;
  let deleteCount = 0;
  let storedView: Record<string, any> | null = null;
  let createdPayload: Record<string, any> | null = null;
  await page.route('**/api/probe/server-views**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      listStarted();
      await listGate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    }
    if (request.method() === 'POST') {
      postCount++;
      createdPayload = request.postDataJSON();
      await createGate;
      storedView = { id: 'pending-view', ...createdPayload, createdAt: 'now', updatedAt: 'now' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(storedView) });
    }
    if (request.method() === 'PATCH') {
      patchCount++;
      await renameGate;
      Object.assign(storedView!, request.postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(storedView) });
    }
    if (request.method() === 'DELETE') {
      deleteCount++;
      await deleteGate;
      storedView = null;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    return route.fallback();
  });

  await page.goto('/servers?q=initial-query');
  await listStartedGate;
  await page.getByLabel('新视图名称').fill('Pending');
  await page.getByPlaceholder('搜索 IP / 标签 / 分组').fill('instant-query');
  await page.getByRole('button', { name: '保存当前视图' }).click();
  const createButton = page.getByRole('button', { name: '保存中…' });
  await expect(createButton).toBeDisabled();
  await createButton.click({ force: true });
  expect(postCount).toBe(1);
  expect(createdPayload).toMatchObject({ filters: { q: 'instant-query' } });
  releaseCreate();
  await expect(page.getByLabel('加载保存视图')).toContainText('Pending');
  await expect(page).toHaveURL(/q=instant-query/);
  releaseList();
  await expect(page.getByLabel('加载保存视图')).toContainText('Pending');

  await page.getByRole('button', { name: '重命名' }).click();
  await page.getByLabel('视图新名称').fill('Renamed');
  await page.getByRole('button', { name: '确认重命名' }).click();
  const renameButton = page.getByRole('button', { name: '重命名中…' });
  await expect(renameButton).toBeDisabled();
  await renameButton.click({ force: true });
  expect(patchCount).toBe(1);
  releaseRename();
  await expect(page.getByLabel('加载保存视图')).toContainText('Renamed');

  await page.getByRole('button', { name: '删除视图' }).click();
  const confirmDelete = page.getByRole('alertdialog').getByRole('button', { name: '删除视图' });
  await confirmDelete.click();
  const deletingButton = page.getByRole('alertdialog').getByRole('button', { name: '删除中…' });
  await expect(deletingButton).toBeDisabled();
  await deletingButton.click({ force: true });
  expect(deleteCount).toBe(1);
  releaseDelete();
  await expect(page.getByLabel('加载保存视图')).toContainText('当前筛选');
});

test('server view creation preserves edits made while its POST is pending', async ({page}) => {
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let createdPayload: Record<string, any> | null = null;
  await page.route('**/api/probe/server-views**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    if (request.method() === 'POST') {
      createdPayload = request.postDataJSON();
      await createGate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'delayed-view', ...createdPayload, createdAt: 'now', updatedAt: 'now' }) });
    }
    return route.fallback();
  });

  await page.goto('/servers?q=before&sort=ip&order=asc');
  await page.getByLabel('新视图名称').fill('Snapshot');
  await page.getByRole('button', { name: '保存当前视图' }).click();
  await expect(page.getByRole('button', { name: '保存中…' })).toBeDisabled();
  expect(createdPayload).toMatchObject({ filters: { q: 'before' }, sort: 'ip', order: 'asc' });

  await page.getByPlaceholder('搜索 IP / 标签 / 分组').fill('after');
  await page.locator('thead').getByRole('button', { name: /分组/ }).click();
  await page.getByLabel('显示列 路由').uncheck();
  await expect(page).toHaveURL(/q=after/);
  await expect(page).toHaveURL(/sort=group/);
  releaseCreate();

  await expect(page.getByLabel('加载保存视图')).toContainText('当前筛选');
  await expect(page).toHaveURL(/q=after/);
  await expect(page).toHaveURL(/sort=group/);
  await expect(page.getByLabel('显示列 路由')).not.toBeChecked();
  await page.getByLabel('加载保存视图').click();
  await expect(page.getByRole('option', { name: 'Snapshot' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重命名' })).toHaveCount(0);
});

test('quick saved view ignores page and cursor changes caused by immediate search submit', async ({page}) => {
  await page.addInitScript(() => {
    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) =>
      originalSetTimeout(handler, timeout === 300 ? 10_000 : timeout, ...args)) as typeof window.setTimeout;
  });
  let createdPayload: Record<string, any> | null = null;
  await page.route('**/api/probe/server-views**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    if (request.method() === 'POST') {
      createdPayload = request.postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'quick-view', ...createdPayload, createdAt: 'now', updatedAt: 'now' }) });
    }
    return route.fallback();
  });

  await page.goto('/servers?page=3&pageSize=25&cursor=cursor-before&q=before&sort=ip&order=asc');
  await page.getByLabel('新视图名称').fill('Quick view');
  await page.getByPlaceholder('搜索 IP / 标签 / 分组').fill('quick-query');
  await page.getByRole('button', { name: '保存当前视图' }).click();
  await expect(page.getByLabel('加载保存视图')).toContainText('Quick view');
  expect(createdPayload).toMatchObject({ filters: { q: 'quick-query' }, sort: 'ip', order: 'asc' });
  expect(createdPayload).not.toHaveProperty('page');
  expect(createdPayload).not.toHaveProperty('cursor');
  await expect(page).toHaveURL(/q=quick-query/);
  await expect(page).toHaveURL(/page=1/);
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.getByRole('button', { name: '重命名' })).toBeVisible();
});

test('Back and Forward restore snapshot scope and mode without creating another selection',async ({page})=>{
  const selectionCreates:Record<string,unknown>[]=[];
  page.on('request',(request)=>{if(new URL(request.url()).pathname==='/api/probe/server-selections' && request.method()==='POST')selectionCreates.push(request.postDataJSON());});
  await page.goto('/tests/new');
  await page.getByLabel('目标范围').selectOption('all');
  await expect(page.getByText(/冻结快照目标：120 台/)).toBeVisible();
  expect(selectionCreates).toHaveLength(1);
  await page.getByRole('button',{name:'下一步'}).click();
  await page.getByLabel('测试方式').selectOption('speed');
  await expect(page).toHaveURL(/mode=speed/);

  await page.goBack();
  await expect(page).not.toHaveURL(/mode=speed/);
  await expect(page.getByLabel('测试方式')).toHaveValue('full');
  await page.goForward();
  await expect(page.getByLabel('测试方式')).toHaveValue('speed');
  await page.goBack();
  await expect(page.getByLabel('测试方式')).toHaveValue('full');
  await page.getByRole('button',{name:'上一步'}).click();
  await page.goBack();
  await expect(page.getByLabel('目标范围')).toHaveValue('');
  await page.goForward();
  await expect(page.getByLabel('目标范围')).toHaveValue('all');
  await expect(page.getByText(/冻结快照目标：120 台/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await page.goForward();
  await expect(page.getByLabel('测试方式')).toHaveValue('speed');
  expect(selectionCreates).toHaveLength(1);
});

test('group and all test scopes snapshot matches without paging server assets',async ({page})=>{
  const assetPageRequests:string[]=[];
  const selectionBodies:Record<string,unknown>[]=[];
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(['/api/probe/servers','/api/probe/servers/cursor'].includes(url.pathname))assetPageRequests.push(url.pathname);
    if(url.pathname==='/api/probe/server-selections' && request.method()==='POST')selectionBodies.push(request.postDataJSON());
  });
  await page.goto('/tests/new');
  await page.getByLabel('目标范围').selectOption('group');
  await page.getByLabel('分组').selectOption('QA');
  await expect(page.getByText(/冻结快照目标：1 台/)).toBeVisible();
  await page.getByLabel('目标范围').selectOption('all');
  await expect(page.getByText(/冻结快照目标：120 台/)).toBeVisible();
  expect(selectionBodies).toHaveLength(2);
  expect(selectionBodies[0]).toMatchObject({allMatching:true,group:'QA'});
  expect(selectionBodies[1]).toMatchObject({allMatching:true});
  expect(assetPageRequests).toEqual([]);
  await expect(page).toHaveURL(/selectionId=all-selection/);
  await page.reload();
  await expect(page.getByText(/冻结快照目标：120 台/)).toBeVisible();
  expect(selectionBodies).toHaveLength(2);
  expect(assetPageRequests).toEqual([]);
  await page.getByLabel('目标范围').selectOption('group');
  await page.getByLabel('分组').selectOption('QA');
  await expect(page.getByText(/冻结快照目标：1 台/)).toBeVisible();
  expect(selectionBodies).toHaveLength(3);
  expect(selectionBodies[2]).toMatchObject({allMatching:true,group:'QA'});
});

test('queued all-matching snapshot continues polling after its ID enters the URL',async ({page})=>{
  let creates=0;let polls=0;
  await page.route('**/api/probe/server-selections**',async (route)=>{
    const request=route.request();
    if(request.method()==='POST'){
      creates++;
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({selectionId:'queued-selection',state:'queued',count:7,processed:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),error:null})});
    }
    polls++;
    const ready=polls>=2;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({selectionId:'queued-selection',state:ready?'ready':'building',count:7,processed:ready?7:3,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),error:null})});
  });
  await page.goto('/tests/new');
  await page.getByLabel('目标范围').selectOption('all');
  await expect(page).toHaveURL(/selectionId=queued-selection/);
  await expect(page.getByText(/冻结快照目标：7 台 · 状态：ready/)).toBeVisible({timeout:7000});
  expect(creates).toBe(1);
  expect(polls).toBeGreaterThanOrEqual(2);
});

test('server advanced filters use stable IDs, contextual counts, and browser history',async ({page})=>{
  const facetQueries:string[]=[];
  const pageQueries:string[]=[];
  let releaseGroupFacet!:()=>void;
  let groupFacetStartedResolve!:()=>void;
  const groupFacetStarted=new Promise<void>((resolve)=>{groupFacetStartedResolve=resolve;});
  const groupFacetGate=new Promise<void>((resolve)=>{releaseGroupFacet=resolve;});
  const openAdvanced=async()=>{
    const panel=page.locator('details').filter({hasText:'高级分组与标签筛选'});
    if(!await panel.evaluate((element)=>(element as HTMLDetailsElement).open))await panel.locator('summary').click();
  };
  await page.route('**/api/probe/servers/facets**',async (route)=>{
    const url=new URL(route.request().url());
    facetQueries.push(url.toString());
    if(url.searchParams.get('group')==='QA'){
      groupFacetStartedResolve();
      await groupFacetGate;
    }
    const contextualTags=url.searchParams.has('group') || url.searchParams.has('groupIds') ? 3 : 1;
    const constrainedGroups=url.searchParams.has('includeTagIds') || url.searchParams.has('excludeTagIds');
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      groups:constrainedGroups?[{group:'QA',count:9},{group:'West',count:4}]:[{group:'QA',count:5},{group:'West',count:3}],
      labels:[],
      tagItems:[
        {tagId:'tag-region-cn',categoryId:'region',category:'地区',name:'CN',count:contextualTags},
        {tagId:'tag-carrier-cn',categoryId:'carrier',category:'线路',name:'CN',count:2},
        {tagId:'tag-purpose-edge',categoryId:'purpose',category:'用途',name:'Edge',count:1},
      ],
      tagPage:Number(url.searchParams.get('tagPage') || 1),
      tagPageSize:Number(url.searchParams.get('tagPageSize') || 50),
      tagTotal:3,
    })});
  });
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/probe/servers' || url.pathname==='/api/probe/servers/cursor')pageQueries.push(url.toString());
  });
  await page.goto('/servers');
  await page.getByText('高级分组与标签筛选').click();
  await expect(page.locator('label').filter({hasText:'QA (5)'})).toBeVisible();
  await page.getByLabel('单一分组筛选').click();
  await page.getByRole('option',{name:/QA/}).click();
  await expect(page).toHaveURL(/group=QA/);
  await groupFacetStarted;
  await expect(page.getByText('正在加载标签候选…').last()).toBeVisible();
  releaseGroupFacet();
  await expect(page.locator('label').filter({hasText:'地区 / CN (3)'}).first()).toBeVisible();

  await page.getByLabel('选择分组 West').check();
  await expect(page).toHaveURL(/groupIds=group-west/);
  await expect(page).not.toHaveURL(/(?:\?|&)group=QA/);
  await page.getByLabel('选择分组 QA').check();
  let filters=new URL(page.url()).searchParams;
  expect(filters.get('groupIds')?.split(',').sort()).toEqual(['group-qa','group-west']);
  await page.getByLabel('单一分组筛选').click();
  await page.getByRole('option',{name:/QA/}).click();
  filters=new URL(page.url()).searchParams;
  expect(filters.get('group')).toBe('QA');
  expect(filters.has('groupIds')).toBe(false);
  await expect(page.locator('label').filter({hasText:'地区 / CN (3)'}).first()).toBeVisible();

  await page.getByLabel('选择分组 QA').check();
  await page.getByLabel('选择分组 West').check();
  await expect(page).toHaveURL(/groupIds=group-qa%2Cgroup-west/);
  await page.getByRole('checkbox',{name:'包含标签 地区 / CN'}).check();
  await page.getByRole('checkbox',{name:'包含标签 线路 / CN'}).check();
  filters=new URL(page.url()).searchParams;
  expect(filters.get('includeTagIds')?.split(',').sort()).toEqual(['tag-carrier-cn','tag-region-cn']);
  expect(filters.get('tagMode') || 'any').toBe('any');
  await expect(page.locator('label').filter({hasText:'QA (9)'})).toBeVisible();
  await page.getByLabel('包含标签匹配').selectOption('all');
  await expect(page).toHaveURL(/tagMode=all/);
  await page.getByRole('checkbox',{name:'排除标签 用途 / Edge'}).check();
  filters=new URL(page.url()).searchParams;
  expect(filters.get('excludeTagIds')).toBe('tag-purpose-edge');
  await expect.poll(()=>facetQueries.some((value)=>{
    const query=new URL(value).searchParams;
    return query.get('groupIds')==='group-qa,group-west'
      && query.get('includeTagIds')==='tag-region-cn,tag-carrier-cn'
      && query.get('excludeTagIds')==='tag-purpose-edge'
      && query.get('tagMode')==='all';
  })).toBe(true);

  await page.reload();
  await page.getByText('高级分组与标签筛选').click();
  await expect(page.getByLabel('选择分组 QA')).toBeChecked();
  await expect(page.getByLabel('选择分组 West')).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'包含标签 地区 / CN'})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'包含标签 线路 / CN'})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'排除标签 用途 / Edge'})).toBeChecked();
  await expect(page.getByLabel('包含标签匹配')).toHaveValue('all');
  await page.goBack();
  await expect(page).not.toHaveURL(/excludeTagIds=/);
  await openAdvanced();
  await expect(page.getByRole('checkbox',{name:'排除标签 用途 / Edge'})).not.toBeChecked();
  await page.goForward();
  await openAdvanced();
  await expect(page.getByRole('checkbox',{name:'排除标签 用途 / Edge'})).toBeChecked();
  await page.getByRole('checkbox',{name:'排除标签 线路 / CN'}).check();
  await page.getByRole('button',{name:/^用途 Edge/}).click();
  filters=new URL(page.url()).searchParams;
  expect(filters.get('tagId')).toBe('tag-purpose-edge');
  expect(filters.get('excludeTagIds')).toBe('tag-carrier-cn');
  expect(filters.has('includeTagIds')).toBe(false);
  expect(pageQueries.every((value)=>Number(new URL(value).searchParams.get('pageSize') || 0)!==200)).toBe(true);
});

test('tag candidate search and paging stay bounded while applied IDs survive filter changes',async ({page})=>{
  const facetQueries:string[]=[];
  const assetQueries:string[]=[];
  const candidates=Array.from({length:55},(_,index)=>({
    tagId:`tag-${String(index).padStart(2,'0')}`,categoryId:'candidate',category:'分类',
    name:index===52?'Special North':index===53?'Special South':`Candidate ${String(index).padStart(2,'0')}`,
    count:2,
  }));
  await page.route('**/api/probe/servers/facets**',async (route)=>{
    const url=new URL(route.request().url());
    facetQueries.push(url.toString());
    const search=url.searchParams.get('tagSearch') || '';
    const filtered=candidates.filter((tag)=>tag.name.toLowerCase().includes(search.toLowerCase()));
    const tagPage=Number(url.searchParams.get('tagPage') || 1);
    const tagPageSize=Number(url.searchParams.get('tagPageSize') || 50);
    const group=url.searchParams.get('group');
    const include=url.searchParams.get('includeTagIds');
    const groupCount=include ? 9 : 5;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      labels:[],
      groups:[{group:'QA',count:groupCount},{group:'West',count:3}],
      tagItems:filtered.slice((tagPage-1)*tagPageSize,tagPage*tagPageSize).map((tag)=>({...tag,count:group==='QA'?6:2})),
      tagPage,tagPageSize,tagTotal:filtered.length,
    })});
  });
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/probe/servers' || url.pathname==='/api/probe/servers/cursor')assetQueries.push(url.toString());
  });
  await page.goto('/servers');
  await page.getByText('高级分组与标签筛选').click();
  await expect(page.getByText('显示 1–50 / 55 个标签',{exact:true})).toBeVisible();
  await expect(page.locator('label').filter({hasText:'QA (5)'})).toBeVisible();
  await page.getByRole('checkbox',{name:'包含标签 分类 / Candidate 00'}).check();
  await expect(page.locator('label').filter({hasText:'QA (9)'})).toBeVisible();
  await page.getByRole('button',{name:'下一页标签候选'}).click();
  await expect(page.getByText('显示 51–55 / 55 个标签',{exact:true})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'包含标签 分类 / Candidate 50'})).toBeVisible();
  await page.getByRole('checkbox',{name:'包含标签 分类 / Candidate 50'}).click();
  let filters=new URL(page.url()).searchParams;
  expect(filters.get('includeTagIds')?.split(',').sort()).toEqual(['tag-00','tag-50']);
  await expect(page.getByText('显示 1–50 / 55 个标签',{exact:true})).toBeVisible();
  await expect.poll(()=>facetQueries.some((value)=>{
    const query=new URL(value).searchParams;
    return query.get('tagPage')==='2' && query.get('tagPageSize')==='50' && query.get('includeTagIds')==='tag-00';
  })).toBe(true);

  await page.getByLabel('搜索标签候选').fill('Special');
  await expect(page.getByText('显示 1–2 / 2 个标签',{exact:true})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'包含标签 分类 / Special North'})).toBeVisible();
  filters=new URL(page.url()).searchParams;
  expect(filters.get('includeTagIds')?.split(',').sort()).toEqual(['tag-00','tag-50']);
  expect(filters.has('tagSearch')).toBe(false);
  expect(filters.has('tagPage')).toBe(false);
  await page.getByLabel('搜索标签候选').fill('');
  await expect(page.getByText('显示 1–50 / 55 个标签',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'下一页标签候选'}).click();
  await expect(page.getByText('显示 51–55 / 55 个标签',{exact:true})).toBeVisible();
  await page.getByLabel('单一分组筛选').click();
  await page.getByRole('option',{name:/QA/}).click();
  await expect(page).toHaveURL(/group=QA/);
  await expect(page.getByText('显示 1–50 / 55 个标签',{exact:true})).toBeVisible();
  await expect(page.locator('label').filter({hasText:'Candidate 00 (6)'}).first()).toBeVisible();
  await page.getByLabel('搜索标签候选').fill('Special');
  await expect(page.getByText('显示 1–2 / 2 个标签',{exact:true})).toBeVisible();
  filters=new URL(page.url()).searchParams;
  expect(filters.get('includeTagIds')?.split(',').sort()).toEqual(['tag-00','tag-50']);
  expect(filters.has('groupIds')).toBe(false);
  await expect.poll(()=>facetQueries.some((value)=>{
    const query=new URL(value).searchParams;
    return query.get('group')==='QA' && query.get('tagSearch')==='Special' && query.get('tagPage')==='1' && query.get('includeTagIds')==='tag-00,tag-50';
  })).toBe(true);
  expect(assetQueries.every((value)=>Number(new URL(value).searchParams.get('pageSize') || 0)!==200)).toBe(true);
});

test('manual targets reject explicit ports other than 7000', async ({page})=>{
  let submissions=0;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST')submissions++;});
  await page.goto('/tests/new');
  await page.getByLabel('目标范围').selectOption('manual');
  await page.locator('textarea').fill('192.0.2.8:7001');
  await expect(page.getByRole('alert').filter({hasText:'端口固定为 7000'})).toBeVisible();
  await expect(page.getByRole('button',{name:'下一步'})).toBeDisabled();
  expect(submissions).toBe(0);
});

test('manual target lists above 5000 are blocked and point to frozen server snapshots',async ({page})=>{
  let submissions=0;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST')submissions++;});
  await page.goto('/tests/new');
  await page.getByLabel('目标范围').selectOption('manual');
  // Use distinct valid addresses to test the count boundary.
  const targets=Array.from({length:5001},(_,index)=>`198.18.${Math.floor(index/256)}.${index%256}`).join('\n');
  // Simulate a large paste without the headless browser's slow text-insertion path.
  await page.locator('textarea').evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, targets);
  await expect(page.getByRole('alert').filter({hasText:'手动目标共 5001 个，超过 5000 个上限'})).toBeVisible();
  await expect(page.getByRole('link',{name:'前往服务器库冻结匹配结果'})).toHaveAttribute('href','/servers');
  await expect(page.getByRole('button',{name:'下一步'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'提交测试'})).toHaveCount(0);
  expect(submissions).toBe(0);
});

test('invalid saved policy links to node settings and blocks job submission', async ({page})=>{
  let submissions=0;
  await page.route('**/api/probe/nodes/execution-policy',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'primary policy is invalid'})}));
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST')submissions++;});
  await page.goto('/tests/new');
  await page.getByLabel('目标范围').selectOption('manual');
  await page.locator('textarea').fill('192.0.2.8');
  await page.getByRole('button',{name:'下一步'}).click();
  await expect(page.getByRole('alert').filter({hasText:'执行节点策略加载失败'})).toBeVisible();
  await expect(page.getByRole('link',{name:'打开测试节点设置修复'})).toHaveAttribute('href','/test-nodes');
  await expect(page.getByRole('button',{name:'下一步'})).toBeDisabled();
  expect(submissions).toBe(0);
});

test('node list failure is distinct, retryable, and blocks submission until resolved',async ({page})=>{
  let nodeRequests=0;
  await page.route('**/api/probe/nodes',async route=>{
    nodeRequests++;
    if(nodeRequests===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'temporary node service error'})});
    return route.fallback();
  });
  let submissions=0;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST')submissions++;});
  await page.goto('/tests/new');
  await page.getByLabel('目标范围').selectOption('manual');
  await page.locator('textarea').fill('192.0.2.8');
  await page.getByRole('button',{name:'下一步'}).click();
  await expect(page.getByRole('alert').filter({hasText:'节点列表加载失败'})).toBeVisible();
  await expect(page.getByRole('button',{name:'下一步'})).toBeDisabled();
  expect(submissions).toBe(0);
  await page.getByRole('button',{name:'重试加载'}).click();
  await expect(page.getByText(/主节点：国内测试节点/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await page.getByRole('button',{name:'提交测试'}).click();
  await expect(page).toHaveURL(/\/tests\/created-qa-job/);
  expect(submissions).toBe(1);
});

test('network discovery uses the configured primary and fixed port 7000',async ({page})=>{
  let submitted:Record<string,unknown>|null=null;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST')submitted=request.postDataJSON();});
  await page.goto('/discovery');
  await page.getByRole('button',{name:'开始扫描'}).click();
  await page.getByLabel(/目标网段/).fill('192.0.2.0/24');
  await page.getByRole('button',{name:'开始扫描'}).last().click();
  await expect.poll(()=>submitted).not.toBeNull();
  expect(submitted).toMatchObject({mode:'discover',port:7000});
  expect(submitted).not.toHaveProperty('nodeIds');
  await expect(page.getByLabel('frps 端口')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'来源对比'})).toHaveCount(0);
});

test('old group link only prefills the new test form',async ({page})=>{
  let submissions=0;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST')submissions++;});
  await page.goto('/probe?tab=test&group=QA&nodeId=remote');
  await expect(page).toHaveURL(/\/tests\/new\?group=QA/);
  await expect(page.getByLabel('目标范围')).toHaveValue('group');
  await expect(page.getByLabel('分组')).toHaveValue('QA');
  await page.screenshot({path:'test-results/test-create-group-1280.png',fullPage:true});
  expect(submissions).toBe(0);
});

test('legacy server link keeps its query but current results use the unified projection', async ({page})=>{
  const serverRequests:string[]=[];
  page.on('request',(request)=>{
    if(['/api/probe/servers','/api/probe/servers/cursor'].includes(new URL(request.url()).pathname))serverRequests.push(request.url());
  });
  await page.goto('/probe?tab=servers&nodeId=remote');
  await expect(page).toHaveURL(/\/servers\?nodeId=remote/);
  await expect(page.getByText(/当前结果反映最近一次被接受的主用或备用测量/)).toBeVisible();
  await expect(page.getByRole('combobox',{name:'观测来源'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'对比'})).toHaveCount(0);
  await expect(page.getByText(/结果来源：/)).toHaveCount(0);
  await expect.poll(()=>serverRequests.length).toBeGreaterThan(0);
  expect(serverRequests.every((url)=>!new URL(url).searchParams.has('nodeId'))).toBe(true);
  await page.reload();
  await expect(page).toHaveURL(/\/servers\?nodeId=remote/);
  await expect(page.getByText(/当前结果反映最近一次被接受的主用或备用测量/)).toBeVisible();
});

test('legacy node query parameters do not filter task lists or aggregate discovery',async ({page})=>{
  const requests:string[]=[];
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(['/api/probe/jobs','/api/probe/discover/results','/api/probe/discover/facets'].includes(url.pathname))requests.push(request.url());
  });
  await page.goto('/tests?nodeId=remote&listNode=remote');
  await expect(page.getByLabel('执行节点')).toHaveCount(0);
  await expect.poll(()=>requests.some((request)=>new URL(request).pathname==='/api/probe/jobs')).toBe(true);
  await page.goto('/discovery?nodeId=remote');
  await expect(page.getByRole('combobox',{name:'观测来源'})).toHaveCount(0);
  await expect.poll(()=>requests.some((request)=>new URL(request).pathname==='/api/probe/discover/results')).toBe(true);
  expect(requests.every((request)=>!new URL(request).searchParams.has('nodeId'))).toBe(true);
});

test('asset pagination stays in the URL after refresh',async ({page})=>{
  const cursorRequests:string[]=[];let countRequests=0;
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/probe/servers/cursor')cursorRequests.push(request.url());
    if(url.pathname==='/api/probe/servers/count')countRequests++;
  });
  await page.goto('/servers?nodeId=remote&pageSize=25');
  await expect(page.getByText(/当前结果反映最近一次被接受的主用或备用测量/)).toBeVisible();
  await expect.poll(()=>cursorRequests.length).toBeGreaterThan(0);
  await expect.poll(()=>countRequests).toBeGreaterThan(0);
  await page.getByRole('button',{name:'下一页'}).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page).toHaveURL(/cursor=cursor-page2/);
  await page.reload();
  await expect(page.getByText('192.0.2.2',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'上一页'}).click();
  await expect(page).toHaveURL(/page=1/);
  await expect(page).not.toHaveURL(/cursor=/);
  await page.getByRole('button',{name:'下一页'}).click();
  await page.goBack();
  await expect(page).toHaveURL(/page=1/);
});

test('non-IP server sort keeps using the offset compatibility endpoint',async ({page})=>{
  let offsetRequests=0;let cursorRequests=0;
  page.on('request',(request)=>{
    const path=new URL(request.url()).pathname;
    if(path==='/api/probe/servers')offsetRequests++;
    if(path==='/api/probe/servers/cursor')cursorRequests++;
  });
  await page.goto('/servers?sort=group&nodeId=remote');
  await expect.poll(()=>offsetRequests).toBeGreaterThan(0);
  expect(cursorRequests).toBe(0);
});

test('server cursor restores browser back and forward URLs',async ({page})=>{
  const cursorRequests:string[]=[];
  page.on('request',(request)=>{if(new URL(request.url()).pathname==='/api/probe/servers/cursor')cursorRequests.push(request.url());});
  await page.goto('/servers?nodeId=remote&pageSize=25');
  await page.getByRole('button',{name:'下一页'}).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page).toHaveURL(/cursor=cursor-page2/);
  await page.goBack();
  await expect(page).toHaveURL(/page=1/);
  await expect(page).not.toHaveURL(/cursor=/);
  await expect.poll(()=>cursorRequests.some((value)=>!new URL(value).searchParams.has('cursor'))).toBe(true);
  await expect(page.getByText('192.0.2.1:7000',{exact:true})).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/page=2/);
  await expect(page).toHaveURL(/cursor=cursor-page2/);
  await expect(page.getByText('192.0.2.2',{exact:true})).toBeVisible();
});

test('cursor page and count failures show retry states without false zero or empty data',async ({page})=>{
  await page.goto('/servers');
  await page.getByPlaceholder('搜索 IP / 标签 / 分组').fill('qa-page-failure');
  await expect(page.getByText(/服务器列表读取失败：/)).toBeVisible();
  await expect(page.getByRole('button',{name:'重试列表'})).toBeVisible();
  await expect(page.getByText(/服务器总数读取失败：/)).toBeVisible();
  await expect(page.getByRole('button',{name:'重试总数'})).toBeVisible();
  await expect(page.getByText('总数暂不可用',{exact:true})).toBeVisible();
  await expect(page.getByText(/共 总数暂不可用/)).toBeVisible();
  await expect(page.getByText('192.0.2.1:7000',{exact:true})).toBeVisible();
  await expect(page.getByText('暂无服务器，点击「添加」或「批量导入」开始',{exact:true})).toHaveCount(0);
  await expect(page.getByText('0 台',{exact:true})).toHaveCount(0);
});

test('count failures are separate from page results and preserve last successful rows',async ({page})=>{
  await page.goto('/servers');
  await expect(page.getByText('192.0.2.1:7000',{exact:true})).toBeVisible();
  await page.getByPlaceholder('搜索 IP / 标签 / 分组').fill('qa-count-failure');
  await expect(page.getByText(/服务器总数读取失败：/)).toBeVisible();
  await expect(page.getByRole('button',{name:'重试总数'})).toBeVisible();
  await expect(page.getByText('总数暂不可用',{exact:true})).toBeVisible();
  await expect(page.getByText('暂无服务器，点击「添加」或「批量导入」开始',{exact:true})).toHaveCount(0);
});

test('late count response stays attached to the filter that requested it',async ({page})=>{
  let slowCountStarted=false;
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/probe/servers/count' && url.searchParams.get('tagId')==='tag-carrier-cn')slowCountStarted=true;
  });
  await page.goto('/servers?tagId=tag-carrier-cn');
  await expect.poll(()=>slowCountStarted).toBe(true);
  await page.getByRole('button',{name:'地区 CN 1'}).click();
  await expect(page.getByText(/共 88 台/)).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByText(/共 88 台/)).toBeVisible();
  await expect(page.getByText(/共 77 台/)).toHaveCount(0);
});

test('server tags group by category, filter with stable id, and batch assignment sends tag ids',async ({page})=>{
  const serverRequests:string[]=[];let assignment:Record<string,unknown>|null=null;
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/probe/servers' || url.pathname==='/api/probe/servers/cursor')serverRequests.push(request.url());
    if(url.pathname==='/api/probe/server-bulk-jobs' && request.method()==='POST')assignment=request.postDataJSON();
  });
  await page.goto('/servers?nodeId=remote&group=QA');
  await expect(page.getByText('地区',{exact:true})).toBeVisible();
  await expect(page.getByText('线路',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'地区 CN 1'}).click();
  await expect(page).toHaveURL(/tagId=tag-region-cn/);
  await expect(page).toHaveURL(/group=QA/);
  await expect.poll(()=>serverRequests.some((value)=>new URL(value).searchParams.get('tagId')==='tag-region-cn')).toBe(true);
  expect(serverRequests.some((value)=>new URL(value).searchParams.get('group')==='QA')).toBe(true);
  await page.getByRole('button',{name:'地区 CN 1'}).click();
  await page.getByLabel('选择 192.0.2.1:7000').check();
  await page.getByRole('button',{name:'分类标签',exact:true}).click();
  await page.getByRole('button',{name:'添加'}).first().click();
  await page.getByRole('button',{name:'保存'}).click();
  await expect.poll(()=>assignment).not.toBeNull();
  expect(assignment).toMatchObject({selectionId:'all-selection',operation:'update',payload:{addTagIds:['tag-region-cn'],removeTagIds:[]},idempotencyKey:expect.any(String)});
  expect(assignment).not.toHaveProperty('ids');
});

test('tag management creates, renames, moves, and merges by stable ids',async ({page})=>{
  const calls:{url:string;method:string;body:unknown}[]=[];
  page.on('request',(request)=>{if(request.url().includes('/api/probe/tags'))calls.push({url:new URL(request.url()).pathname,method:request.method(),body:request.postDataJSON()});});
  await page.goto('/servers');
  await page.getByRole('button',{name:'标签管理'}).click();
  await page.getByLabel('新分类名称').fill('地区');
  await expect(page.getByRole('button',{name:'创建'})).toBeVisible();
  await page.getByRole('button',{name:'创建'}).click();
  await page.getByLabel('新标签名称').fill('新标签');
  await page.getByRole('button',{name:'添加'}).click();
  await page.getByLabel('地区分类名称').fill('地区新版');
  await page.getByRole('button',{name:'重命名分类 地区'}).click();
  await expect.poll(()=>calls.some((call)=>call.method==='PATCH' && call.url.endsWith('/categories/region'))).toBe(true);
  await page.getByLabel('CN标签名称').first().fill('CN2');
  await page.getByRole('button',{name:'保存标签 CN'}).first().click();
  await page.getByLabel('移动 CN 到分类').first().click();
  await page.getByRole('option',{name:'线路'}).click();
  await page.getByRole('button',{name:'保存标签 CN'}).first().click();
  await expect.poll(()=>calls.some((call)=>call.method==='PATCH' && call.url.endsWith('/tag-region-cn') && (call.body as {categoryId?:string}).categoryId==='carrier')).toBe(true);
  await page.getByLabel('合并 CN 到').first().click();
  await page.getByRole('option',{name:'线路 / CN'}).click();
  await page.getByRole('button',{name:'合并'}).first().click();
  await expect.poll(()=>calls.some((call)=>call.method==='POST' && call.url.endsWith('/tag-region-cn/merge') && (call.body as {targetTagId?:string}).targetTagId==='tag-carrier-cn')).toBe(true);
});

test('legacy server edit keeps sending label names',async ({page})=>{
  let saved:Record<string,unknown>|null=null;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/servers/1') && request.method()==='PATCH')saved=request.postDataJSON();});
  await page.goto('/servers');
  await page.getByLabel('编辑').first().click();
  await page.getByPlaceholder('CN2,家宽').fill('legacy,compat');
  await page.getByRole('button',{name:'保存'}).last().click();
  await expect.poll(()=>saved).not.toBeNull();
  expect(saved).toMatchObject({labels:['legacy','compat']});
  expect(saved).not.toHaveProperty('tagIds');
});

test('LB settings follows the saved primary policy and keeps the compatibility payload field',async ({page})=>{
  let saved:Record<string,unknown>|null=null;
  page.on('request',(request)=>{
    if(request.url().endsWith('/api/lb/selection-config') && request.method()==='PUT')saved=request.postDataJSON();
  });
  await page.goto('/lb/settings');
  await expect(page.getByText('全局选优结果',{exact:true})).toBeVisible();
  await expect(page.getByText('执行策略主用节点')).toBeVisible();
  await expect(page.getByText('国内测试节点',{exact:true})).toBeVisible();
  await expect(page.getByLabel('观测有效期（小时，1–168）')).toHaveValue('24');
  await expect(page.getByLabel('穿透 / 速率观测节点')).toHaveCount(0);
  await expect(page.getByText(/结果跟随统一测量投影/)).toBeVisible();
  await page.getByLabel('观测有效期（小时，1–168）').fill('48');
  await page.getByRole('button',{name:'保存选优配置'}).click();
  await expect.poll(()=>saved).not.toBeNull();
  expect(saved).toEqual({nodeId:'remote',maxAgeHours:48,healthSource:'console'});
});

test('audit and result totals come from paged server queries',async ({page})=>{
  const historyRequests:string[]=[];
  page.on('request',(request)=>{
    const url=new URL(request.url());
    if(url.pathname==='/api/probe/history/route/page')historyRequests.push(request.url());
  });
  await page.goto('/audit');
  await expect(page.getByText('205 条匹配')).toBeVisible();
  await page.goto('/results?kind=route&nodeId=remote&ip=192.0.2.1');
  await expect(page.getByText('路由 · 共 205 条')).toBeVisible();
  await expect(page.getByLabel('结果来源')).toHaveCount(0);
  await expect(page.getByText('192.0.2.1:7000')).toBeVisible();
  await expect(page.getByRole('button',{name:'来源对比'})).toHaveCount(0);
  expect(historyRequests.length).toBeGreaterThan(0);
  expect(historyRequests.every((request)=>!new URL(request).searchParams.has('nodeId'))).toBe(true);
  await page.reload();
  await expect(page.getByText('路由 · 共 205 条')).toBeVisible();
  await expect(page).toHaveURL(/nodeId=remote/);
});

test('test node policy auto-includes external fallbacks and keeps Console fixed last',async ({page})=>{
  let saved:Record<string,unknown>|null=null;
  await page.route('**/api/probe/nodes/execution-policy',async (route)=>{
    if(route.request().method()==='PUT'){
      saved=route.request().postDataJSON();
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,primaryNodeId:'remote',backupNodeIds:['backup','backup2','console'],suggestedPrimaryNodeId:null})});
    }
    return route.fallback();
  });
  await page.goto('/test-nodes');
  await expect(page.getByText('备用测试节点',{exact:true})).toBeVisible();
  await expect(page.getByText('第二备用节点',{exact:true})).toBeVisible();
  await expect(page.getByText('主控 Console（最终备用）')).toBeVisible();
  await expect(page.getByRole('button',{name:/上移备用节点/})).toHaveCount(2);
  await expect(page.getByRole('button',{name:/下移备用节点/})).toHaveCount(2);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button',{name:'上移备用节点 第二备用节点'}).click();
  await page.getByRole('button',{name:'保存主备策略'}).click();
  await expect.poll(()=>saved).not.toBeNull();
  expect(saved).toEqual({primaryNodeId:'remote',backupNodeIds:['backup2','backup']});
});

test('unknown domain health is not counted as healthy',async ({page})=>{
  await page.goto('/lb');
  const row = page.getByRole('row').filter({ hasText: 'qa.example.com' });
  await expect(row.getByText(/0\s*\/\s*1 健康/)).toBeVisible();
  await expect(row.getByText('1 待检查', { exact: true })).toBeVisible();
  await expect(row.getByText('待检查', { exact: true })).toBeVisible();
  await page.screenshot({path:'test-results/lb-unknown-1280.png',fullPage:true});
  await expect(page.getByRole('button',{name:'候选服务器'})).toBeVisible();
});

test('test creation remains usable at phone width',async ({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/tests/new');
  await expect(page.getByRole('heading',{name:'新建测试',level:2})).toBeVisible();
  const sizes=await page.evaluate(()=>({content:document.documentElement.scrollWidth,viewport:window.innerWidth}));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport);
  await page.screenshot({path:'test-results/test-create-390.png',fullPage:true});
});

test('config draft is protected and unsupported proxy fields stay in raw mode',async ({page})=>{
  await page.goto('/instances/1/demo?tab=config');
  await expect(page.getByText('编辑配置')).toBeVisible();
  await page.getByRole('tab',{name:'原始 TOML'}).click();
  const editor=page.locator('textarea');
  await expect(editor).toHaveValue(/remotePort = 7001/);
  await editor.fill((await editor.inputValue())+'\nplugin = "custom"\n');
  await expect(page.getByText(/结构化编辑尚未覆盖/)).toBeVisible();
  await expect(page.getByRole('tab',{name:'代理（结构化）'})).toBeDisabled();
  await page.locator('a[href="/instances"]').first().click();
  await expect(page.getByText('离开未保存的配置')).toBeVisible();
  await page.getByRole('button',{name:'取消'}).click();
  await expect(page).toHaveURL(/\/instances\/1\/demo/);
});

test('asset handoff keeps the custom port in instance creation',async ({page})=>{
  await page.goto('/create?server=192.0.2.1&port=7001');
  await expect(page).toHaveURL(/\/instances\/new\?server=192.0.2.1&port=7001/);
  await expect(page.getByRole('textbox',{name:'服务器地址'})).toHaveValue('192.0.2.1');
  await expect(page.getByRole('textbox',{name:'端口'})).toHaveValue('7001');
  await expect(page.getByText('第 1 步 / 3 步')).toBeVisible();
});

test('dialog focus and Escape use the shared overlay behavior',async ({page})=>{
  await page.goto('/test-nodes');
  const button=page.getByRole('button',{name:'接入或管理节点'});
  await button.click();
  await expect(page.getByRole('dialog',{name:'测试节点'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'测试节点'})).toBeHidden();
  await expect(button).toBeFocused();
});

test('configured backup without task-generation-v1 is waiting for upgrade and failover history paginates',async ({page})=>{
  await page.goto('/test-nodes');
  await expect(page.getByText('需升级 · 等待协议能力').first()).toBeVisible();
  await expect(page.getByText('task-1')).toBeVisible();
  await page.getByRole('button',{name:'下一页'}).click();
  await expect(page.getByText('task-2')).toBeVisible();
  await expect(page.getByText('第 2 页 / 共 2 页')).toBeVisible();
});

test('waiting status follows pending failover markers and task messages are translated',async ({page})=>{
  await page.route('**/api/probe/nodes',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[
    {id:'console',name:'Console',kind:'console',version:'qa',capabilities:['discover','route','connectivity','speed'],online:true},
    {id:'remote',name:'原主用节点',kind:'worker',version:'qa',capabilities:['discover','route','connectivity','speed'],protocolFeatures:['task-generation-v1'],online:false},
    {id:'backup',name:'当前备用节点',kind:'worker',version:'qa',capabilities:['discover','route','connectivity','speed'],protocolFeatures:['task-generation-v1'],online:true},
  ]})}));
  const detail=(id:string,nodeId:string,waiting:boolean,failoverWaitingCount=waiting?1:0,taskState='pending')=>({
    id,mode:'route',state:'running',options:{},counts:{pending:1,done:taskState==='done'?1:0},nodeIds:['remote','backup'],taskTotal:taskState==='done'?2:1,
    stageCounts:[{nodeId,stage:'route',state:taskState,count:1}],progress:{scanned:0,foundCount:0},
    failoverWaitingCount,createdAt:'2026-10-23T10:00:00+00:00',tasks:[{
      taskId:`task-${id}`,attemptId:null,jobId:id,nodeId,stage:'route',ip:'192.0.2.20',port:7000,
      state:taskState,attempts:0,seq:0,progress:{},error:waiting?'waiting for an online backup':'',
      failover_waiting:waiting?1:0,payload:{},createdAt:'2026-10-23T10:00:00+00:00',result:null,
    }],page:1,pageSize:200,filteredTaskTotal:1,
  });
  await page.route('**/api/probe/jobs/qa-former-owner**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail('qa-former-owner','backup',false))}));
  await page.route('**/api/probe/jobs/qa-waiting**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail('qa-waiting','remote',true))}));
  await page.route('**/api/probe/jobs/qa-filtered-waiting**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail('qa-filtered-waiting','backup',false,1,'done'))}));

  await page.goto('/tests/qa-former-owner');
  await expect(page.getByText('等待备用节点 · 排队中')).toHaveCount(0);

  await page.goto('/tests/qa-waiting');
  await expect(page.getByText('等待备用节点 · 排队中')).toBeVisible();
  await expect(page.getByText('等待在线备用节点接管')).toBeVisible();
  await expect(page.getByText('waiting for an online backup',{exact:true})).toHaveCount(0);

  await page.goto('/tests/qa-filtered-waiting?taskState=done');
  await expect(page.getByText('等待备用节点 · 排队中')).toBeVisible();
  await expect(page.getByText('等待在线备用节点接管')).toHaveCount(0);
});

test('primary pages fit a narrow viewport',async ({page})=>{
  await page.setViewportSize({width:390,height:844});
  for(const path of ['/servers','/lb','/instances']){
    await page.goto(path);
    await expect(page.locator('#main-content')).toBeVisible();
    const sizes=await page.evaluate(()=>({content:document.documentElement.scrollWidth,viewport:window.innerWidth}));
    expect(sizes.content,`${path} overflows document`).toBeLessThanOrEqual(sizes.viewport);
  }
});

test('server import tracks delayed progress, restores after reload, pages failures and retries them', async ({ page }) => {
  let currentJob = 'import-qa-job';
  let polls = 0;
  let retrySubmitted = false;
  const failureRequests: string[] = [];
  let assetPageRequests = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/probe/servers/cursor' || path === '/api/probe/servers') assetPageRequests++;
  });
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/probe/server-import-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-import-jobs' && request.method() === 'POST') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return route.fulfill(json({ jobId: currentJob, state: 'queued', total: 3, processed: 0, inserted: 0, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    if (url.pathname.endsWith('/retry-failed') && request.method() === 'POST') {
      retrySubmitted = true;
      currentJob = 'import-qa-retry';
      polls = 0;
      return route.fulfill(json({ jobId: currentJob, state: 'queued', total: 2, processed: 0, inserted: 0, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    if (url.pathname.endsWith('/failures')) {
      failureRequests.push(url.search);
      const cursor = url.searchParams.get('cursor');
      return route.fulfill(json({
        items: [cursor ? { line: 3, input: 'bad-row-2', error: 'invalid address', retryable: true } : { line: 2, input: 'bad-row-1', error: 'invalid address', retryable: true }],
        nextCursor: cursor ? null : '2',
      }));
    }
    if (url.pathname === `/api/probe/server-import-jobs/${currentJob}`) {
      polls++;
      if (currentJob === 'import-qa-retry') {
        return route.fulfill(json({ jobId: currentJob, state: polls < 2 ? 'running' : 'done', total: 2, processed: polls < 2 ? 1 : 2, inserted: polls < 2 ? 1 : 2, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
      }
      if (polls === 1) return route.fulfill(json({ jobId: currentJob, state: 'running', total: 3, processed: 1, inserted: 1, skipped: 0, failed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
      return route.fulfill(json({ jobId: currentJob, state: 'partial', total: 3, processed: 3, inserted: 1, skipped: 0, failed: 2, retryableFailed: 2, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    return route.fallback();
  });

  await page.goto('/servers');
  await page.getByRole('button', { name: '批量导入' }).click();
  await page.getByPlaceholder(/每行一台/).fill('192.0.2.1\nbad-row-1\nbad-row-2');
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByText('导入任务已提交，可在任务进度中查看结果')).toBeVisible();
  await expect(page.getByText('服务器导入 · 部分完成')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('失败明细（已载入 1 条）')).toBeVisible();
  await expect(page.getByText('bad-row-1')).toBeVisible();
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByText('bad-row-2')).toBeVisible();
  expect(failureRequests.some((query) => query.includes('cursor=2'))).toBe(true);

  await page.reload();
  await expect(page.getByText('服务器导入 · 部分完成')).toBeVisible();
  await expect(page.getByText('bad-row-1')).toBeVisible();
  await page.getByRole('button', { name: '重试失败项' }).click();
  expect(retrySubmitted).toBe(true);
  await expect(page.getByText('服务器导入 · 已完成')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('新增 2', { exact: true })).toBeVisible();
  expect(assetPageRequests).toBeGreaterThan(1);
  expect(await page.evaluate(() => sessionStorage.getItem('probe_server_import_job'))).toContain('import-qa-retry');
});

test('server import restores and replays an uncertain submission with the same body and key', async ({ page }) => {
  const submissions: Record<string, unknown>[] = [];
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/probe/server-import-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-import-jobs' && request.method() === 'POST') {
      submissions.push(request.postDataJSON());
      if (submissions.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'response lost after acceptance' }) });
      }
      return route.fulfill(json({ jobId: 'recovered-import', state: 'queued', total: 2, processed: 0, inserted: 0, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    if (url.pathname === '/api/probe/server-import-jobs/recovered-import') {
      return route.fulfill(json({ jobId: 'recovered-import', state: 'running', total: 2, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    return route.fallback();
  });

  await page.goto('/servers');
  await page.getByRole('button', { name: '批量导入' }).click();
  const importText = '198.51.100.10\n198.51.100.11';
  await page.getByPlaceholder(/每行一台/).fill(importText);
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  const postStarted = page.waitForRequest((request) => request.url().endsWith('/api/probe/server-import-jobs') && request.method() === 'POST');
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await postStarted;
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('probe_server_import_pending'))).toContain('198.51.100.10');
  const persistedBeforeLeave = await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_pending') || 'null')) as Record<string, unknown>;
  await page.goto('/tests/new');
  await page.goto('/servers');

  await page.getByRole('button', { name: '恢复待提交导入' }).click();
  const restoredTextarea = page.getByPlaceholder(/每行一台/);
  await expect(restoredTextarea).toHaveValue(importText);
  await expect(restoredTextarea).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: '重试提交' }).click();
  await expect(page.getByText('服务器导入 · 导入中')).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[1].idempotencyKey).toBe(persistedBeforeLeave.idempotencyKey);
  await expect(page.getByRole('button', { name: '批量导入' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重试失败项' })).toHaveCount(0);
  await expect(page.getByText(/失败明细/)).toHaveCount(0);
});

test('server import failure retry reuses its persisted key after an uncertain response', async ({ page }) => {
  const retryBodies: Record<string, unknown>[] = [];
  let retryPosts = 0;
  let retryState = false;
  let failureReads = 0;
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/probe/server-import-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-import-jobs' && request.method() === 'POST') {
      return route.fulfill(json({ jobId: 'failed-import', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 1, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    if (url.pathname.endsWith('/retry-failed') && request.method() === 'POST') {
      retryPosts++;
      retryBodies.push(request.postDataJSON());
      if (retryPosts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'retry response lost' }) });
      retryState = true;
      return route.fulfill(json({ jobId: 'retried-import', state: 'queued', total: 1, processed: 0, inserted: 0, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    if (url.pathname.endsWith('/failures')) {
      failureReads++;
      if (failureReads === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'failure page unavailable' }) });
      return route.fulfill(json({ items: [{ line: 1, input: 'bad-row', error: 'invalid address', retryable: true }], nextCursor: null }));
    }
    if (url.pathname.endsWith('/retried-import')) return route.fulfill(json({ jobId: 'retried-import', state: 'done', total: 1, processed: 1, inserted: 1, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    if (url.pathname.endsWith('/failed-import')) return route.fulfill(json({ jobId: 'failed-import', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 1, createdAt: 'now', updatedAt: 'now', error: null }));
    return route.fallback();
  });

  await page.goto('/servers');
  await page.getByRole('button', { name: '批量导入' }).click();
  await page.getByPlaceholder(/每行一台/).fill('bad-row');
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByText('failure page unavailable')).toBeVisible();
  await page.getByRole('button', { name: '重试加载失败明细' }).click();
  await expect(page.getByText('bad-row')).toBeVisible();
  await page.getByRole('button', { name: '重试失败项' }).click();
  await expect(page.getByText('retry response lost')).toBeVisible();
  const persistedRetry = await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_retry') || 'null')) as Record<string, unknown>;
  expect(persistedRetry.idempotencyKey).toBe(retryBodies[0].idempotencyKey);
  await page.getByRole('button', { name: '恢复失败项重试', exact: true }).click();
  await expect(page.getByText('服务器导入 · 已完成')).toBeVisible();
  expect(retryState).toBe(true);
  expect(retryBodies).toHaveLength(2);
  expect(retryBodies[1]).toEqual(retryBodies[0]);
  expect(await page.evaluate(() => sessionStorage.getItem('probe_server_import_retry'))).toBeNull();
});

test('an uncertain new import keeps its key and blocks old retry/close actions', async ({ page }) => {
  let importPosts = 0;
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/probe/server-import-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-import-jobs' && request.method() === 'POST') {
      importPosts++;
      if (importPosts === 1) return route.fulfill(json({ jobId: 'older-partial-import', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 1, createdAt: 'now', updatedAt: 'now', error: null }));
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'uncertain new submission' }) });
    }
    if (url.pathname.endsWith('/failures')) return route.fulfill(json({ items: [{ line: 1, input: 'bad-row', error: 'invalid address', retryable: true }], nextCursor: null }));
    if (url.pathname.endsWith('/older-partial-import')) return route.fulfill(json({ jobId: 'older-partial-import', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 1, createdAt: 'now', updatedAt: 'now', error: null }));
    return route.fallback();
  });

  await page.goto('/servers');
  await page.getByRole('button', { name: '批量导入' }).click();
  await page.getByPlaceholder(/每行一台/).fill('bad-row');
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByText('失败明细（已载入 1 条）')).toBeVisible();

  await page.getByRole('button', { name: '批量导入' }).click();
  const pendingText = '198.51.100.21\n198.51.100.22';
  await page.getByPlaceholder(/每行一台/).fill(pendingText);
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByLabel('服务器导入任务').getByText('uncertain new submission')).toBeVisible();
  const pendingBeforeClose = await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_pending') || 'null')) as Record<string, unknown>;
  await page.getByRole('button', { name: '取消' }).click();

  await expect(page.getByRole('button', { name: '重试失败项' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '关闭' })).toBeDisabled();
  await expect(page.getByText('有一项新导入等待确认，请先恢复待提交请求。')).toBeVisible();
  await page.getByRole('button', { name: '恢复待提交导入' }).click();
  await expect(page.getByPlaceholder(/每行一台/)).toHaveValue(pendingText);
  await page.getByRole('button', { name: '取消' }).click();
  const pendingAfter = await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_pending') || 'null')) as Record<string, unknown>;
  expect(pendingAfter.idempotencyKey).toBe(pendingBeforeClose.idempotencyKey);
  expect(pendingAfter.text).toBe(pendingText);
  expect(importPosts).toBe(2);
});

test('a delayed status read for an old import cannot overwrite a newly accepted job', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('probe_server_import_job', JSON.stringify({
    jobId: 'old-terminal-job', state: 'done', total: 1, processed: 1, inserted: 1, skipped: 0, failed: 0, retryableFailed: 0,
    createdAt: 'old', updatedAt: 'old', error: null,
  })));
  let oldReadStarted = false;
  let oldReadFinished = false;
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/probe/server-import-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-import-jobs/old-terminal-job') {
      oldReadStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 1800));
      oldReadFinished = true;
      return route.fulfill(json({ jobId: 'old-terminal-job', state: 'done', total: 1, processed: 1, inserted: 1, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'old', updatedAt: 'old', error: null }));
    }
    if (url.pathname === '/api/probe/server-import-jobs' && request.method() === 'POST') {
      return route.fulfill(json({ jobId: 'new-running-job', state: 'queued', total: 2, processed: 0, inserted: 0, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'new', updatedAt: 'new', error: null }));
    }
    if (url.pathname === '/api/probe/server-import-jobs/new-running-job') {
      return route.fulfill(json({ jobId: 'new-running-job', state: 'partial', total: 2, processed: 2, inserted: 1, skipped: 0, failed: 1, retryableFailed: 0, createdAt: 'new', updatedAt: 'new', error: null }));
    }
    if (url.pathname.endsWith('/failures')) return route.fulfill(json({ items: [{ line: 2, input: 'new-job-failure', error: 'permanent', retryable: false }], nextCursor: null }));
    return route.fallback();
  });

  await page.goto('/servers');
  await expect.poll(() => oldReadStarted).toBe(true);
  await page.getByRole('button', { name: '批量导入' }).click();
  await page.getByPlaceholder(/每行一台/).fill('192.0.2.31\n192.0.2.32');
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.getByLabel('服务器导入任务').getByText('new-job-failure')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_job') || 'null').jobId)).toBe('new-running-job');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_job') || 'null').state)).toBe('partial');

  await expect.poll(() => oldReadFinished).toBe(true);
  await expect(page.getByLabel('服务器导入任务').getByText('new-job-failure')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_job') || 'null').jobId)).toBe('new-running-job');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_job') || 'null').state)).toBe('partial');
});

test('a delayed failure page for an old import does not block a new quick failure page', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('probe_server_import_job', JSON.stringify({
    jobId: 'old-failed-job', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 1,
    createdAt: 'old', updatedAt: 'old', error: null,
  })));
  let oldFailureStarted = false;
  let oldFailureFinished = false;
  let failureRequests = 0;
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/probe/server-import-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-import-jobs/old-failed-job') {
      return route.fulfill(json({ jobId: 'old-failed-job', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 1, createdAt: 'old', updatedAt: 'old', error: null }));
    }
    if (url.pathname === '/api/probe/server-import-jobs' && request.method() === 'POST') {
      return route.fulfill(json({ jobId: 'new-failed-job', state: 'queued', total: 1, processed: 0, inserted: 0, skipped: 0, failed: 0, retryableFailed: 0, createdAt: 'new', updatedAt: 'new', error: null }));
    }
    if (url.pathname === '/api/probe/server-import-jobs/new-failed-job') {
      return route.fulfill(json({ jobId: 'new-failed-job', state: 'partial', total: 2, processed: 2, inserted: 0, skipped: 0, failed: 2, retryableFailed: 1, createdAt: 'new', updatedAt: 'new', error: null }));
    }
    if (url.pathname.endsWith('/failures')) {
      failureRequests++;
      if (url.pathname.includes('/old-failed-job/')) {
        oldFailureStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 1800));
        oldFailureFinished = true;
        return route.fulfill(json({ items: [{ line: 1, input: 'old-row', error: 'old failure', retryable: true }], nextCursor: null }));
      }
      return route.fulfill(json({ items: [{ line: 1, input: 'new-row', error: 'new failure', retryable: true }, { line: 2, input: 'permanent-row', error: 'permanent failure', retryable: false }], nextCursor: null }));
    }
    return route.fallback();
  });

  await page.goto('/servers');
  await expect.poll(() => oldFailureStarted).toBe(true);
  await page.getByRole('button', { name: '批量导入' }).click();
  await page.getByPlaceholder(/每行一台/).fill('new-row');
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();

  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_job') || 'null').jobId)).toBe('new-failed-job');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_job') || 'null').state)).toBe('partial');
  await expect(page.getByLabel('服务器导入任务').getByText('new-row')).toBeVisible();
  await expect(page.getByLabel('服务器导入任务').getByText('permanent-row')).toBeVisible();
  await expect(page.getByLabel('服务器导入任务').getByText('失败 2（可重试 1）')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试失败项（1）' })).toBeVisible();
  expect(failureRequests).toBeGreaterThanOrEqual(2);
  await expect.poll(() => oldFailureFinished).toBe(true);
  await expect(page.getByLabel('服务器导入任务').getByText('new-row')).toBeVisible();
  await expect(page.getByLabel('服务器导入任务').getByText('old-row')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('probe_server_import_job') || 'null').jobId)).toBe('new-failed-job');
});

test('permanent import failures stay visible without a retry action', async ({ page }) => {
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/api/probe/server-import-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-import-jobs' && request.method() === 'POST') {
      return route.fulfill(json({ jobId: 'permanent-only-job', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    }
    if (url.pathname.endsWith('/failures')) return route.fulfill(json({ items: [{ line: 1, input: 'unusable-row', error: 'permanent parse error', retryable: false }], nextCursor: null }));
    if (url.pathname.endsWith('/permanent-only-job')) return route.fulfill(json({ jobId: 'permanent-only-job', state: 'partial', total: 1, processed: 1, inserted: 0, skipped: 0, failed: 1, retryableFailed: 0, createdAt: 'now', updatedAt: 'now', error: null }));
    return route.fallback();
  });

  await page.goto('/servers');
  await page.getByRole('button', { name: '批量导入' }).click();
  await page.getByPlaceholder(/每行一台/).fill('unusable-row');
  await page.getByRole('combobox', { name: '导入业务分组', exact: true }).click();
  await page.getByRole('option', { name: 'QA' }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  const taskCard = page.getByLabel('服务器导入任务');
  await expect(taskCard.getByText('unusable-row')).toBeVisible();
  await expect(taskCard.getByText('永久失败')).toBeVisible();
  await expect(taskCard.getByText('失败 1（可重试 0）')).toBeVisible();
  await expect(page.getByRole('button', { name: /重试失败项/ })).toHaveCount(0);
});

test('all-matching snapshot update reports progress, pages failures, and retries them into a new job', async ({ page }) => {
  const selectionRequests: Record<string, unknown>[] = [];
  const jobRequests: Record<string, unknown>[] = [];
  const retryRequests: Record<string, unknown>[] = [];
  const failureQueries: string[] = [];
  let updatePolls = 0;
  let retryPolls = 0;
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  const selection = (selectionId: string) => ({ selectionId, state: 'ready', count: 120, processed: 120, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', expiresAt: '2026-10-25T00:00:00Z', error: null });
  const bulkJob = (jobId: string, state: string, total: number, processed: number, succeeded: number, failed: number, retryOf: string | null = null) => ({
    jobId, selectionId: 'bulk-update-selection', operation: 'update', state, total, processed, succeeded, failed,
    createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', error: null, retryOf,
  });
  await page.route('**/api/probe/server-selections**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      selectionRequests.push(request.postDataJSON());
      return route.fulfill(json(selection('bulk-update-selection')));
    }
    if (url.pathname.endsWith('/bulk-update-selection')) return route.fulfill(json(selection('bulk-update-selection')));
    return route.fallback();
  });
  await page.route('**/api/probe/server-bulk-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-bulk-jobs' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      jobRequests.push(body);
      return route.fulfill(json(bulkJob('bulk-update-job', 'queued', 120, 0, 0, 0)));
    }
    if (url.pathname.endsWith('/retry-failed') && request.method() === 'POST') {
      retryRequests.push(request.postDataJSON());
      return route.fulfill(json(bulkJob('bulk-update-retry-job', 'queued', 1, 0, 0, 0, 'bulk-update-job')));
    }
    if (url.pathname.endsWith('/failures')) {
      failureQueries.push(url.search);
      const cursor = Number(url.searchParams.get('cursor') || 0);
      return route.fulfill(json({
        items: cursor === 0
          ? [{ serverId: 41, ip: '198.51.100.41', error: 'group update conflict' }]
          : [{ serverId: 42, ip: '198.51.100.42', error: 'server changed during update' }],
        nextCursor: cursor === 0 ? 41 : null,
      }));
    }
    if (url.pathname.endsWith('/bulk-update-job')) {
      updatePolls++;
      return route.fulfill(json(updatePolls === 1
        ? bulkJob('bulk-update-job', 'running', 120, 54, 54, 0)
        : bulkJob('bulk-update-job', 'partial', 120, 120, 119, 1)));
    }
    if (url.pathname.endsWith('/bulk-update-retry-job')) {
      retryPolls++;
      return route.fulfill(json(retryPolls === 1
        ? bulkJob('bulk-update-retry-job', 'running', 1, 0, 0, 0, 'bulk-update-job')
        : bulkJob('bulk-update-retry-job', 'done', 1, 1, 1, 0, 'bulk-update-job')));
    }
    return route.fallback();
  });

  await page.goto('/servers');
  await page.getByRole('button', { name: /冻结全部匹配/ }).click();
  await expect(page.getByLabel('服务器选择快照').getByText('冻结快照 120 台')).toBeVisible();
  await page.getByRole('button', { name: '改分组', exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: '更改分组（120 台）' });
  await editDialog.getByRole('combobox').click();
  await page.getByRole('option', { name: 'West' }).click();
  await editDialog.getByRole('button', { name: '更新', exact: true }).click();

  await expect(page.getByLabel('批量任务进度').getByText('更新任务：54/120')).toBeVisible();
  await expect(page.getByLabel('批量任务进度').getByText('更新任务：部分失败')).toBeVisible();
  await expect(page.getByText('198.51.100.41: group update conflict')).toBeVisible();
  await page.getByRole('button', { name: '加载更多失败项' }).click();
  await expect(page.getByText('198.51.100.42: server changed during update')).toBeVisible();
  expect(failureQueries.some((query) => query.includes('cursor=41'))).toBe(true);
  await page.getByRole('button', { name: '仅重试失败项' }).click();
  await expect(page.getByLabel('批量任务进度').getByText('更新任务：完成')).toBeVisible();

  expect(selectionRequests).toHaveLength(1);
  expect(selectionRequests[0]).toMatchObject({ allMatching: true, conn: 'all' });
  expect(selectionRequests[0]).not.toHaveProperty('ids');
  expect(jobRequests).toHaveLength(1);
  expect(jobRequests[0]).toMatchObject({
    selectionId: 'bulk-update-selection', operation: 'update', payload: { group: 'West' }, idempotencyKey: expect.any(String),
  });
  expect(jobRequests[0]).not.toHaveProperty('ids');
  expect(retryRequests).toHaveLength(1);
  expect(retryRequests[0]).toMatchObject({ idempotencyKey: expect.any(String) });
  expect(Object.keys(retryRequests[0]).sort()).toEqual(['idempotencyKey']);
  expect(retryRequests[0].idempotencyKey).not.toBe(jobRequests[0].idempotencyKey);
  expect(retryPolls).toBeGreaterThan(0);
});

test('frozen selection deletion completes and refreshes the server list', async ({ page }) => {
  const selectionRequests: Record<string, unknown>[] = [];
  const jobRequests: Record<string, unknown>[] = [];
  let deletePolls = 0;
  let assetListRequests = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/probe/servers/cursor' || path === '/api/probe/servers') assetListRequests++;
  });
  const json = (value: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  const selection = { selectionId: 'bulk-delete-selection', state: 'ready', count: 120, processed: 120, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', expiresAt: '2026-10-25T00:00:00Z', error: null };
  const job = (state: string, processed: number, succeeded: number) => ({
    jobId: 'bulk-delete-job', selectionId: 'bulk-delete-selection', operation: 'delete', state, total: 120, processed, succeeded, failed: 0,
    createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', error: null, retryOf: null,
  });
  await page.route('**/api/probe/server-selections**', async (route) => {
    if (route.request().method() === 'POST') {
      selectionRequests.push(route.request().postDataJSON());
      return route.fulfill(json(selection));
    }
    if (new URL(route.request().url()).pathname.endsWith('/bulk-delete-selection')) return route.fulfill(json(selection));
    return route.fallback();
  });
  await page.route('**/api/probe/server-bulk-jobs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/probe/server-bulk-jobs' && request.method() === 'POST') {
      jobRequests.push(request.postDataJSON());
      return route.fulfill(json(job('queued', 0, 0)));
    }
    if (url.pathname.endsWith('/failures')) return route.fulfill(json({ items: [], nextCursor: null }));
    if (url.pathname.endsWith('/bulk-delete-job')) {
      deletePolls++;
      return route.fulfill(json(deletePolls === 1 ? job('running', 64, 64) : job('done', 120, 120)));
    }
    return route.fallback();
  });

  await page.goto('/servers');
  await expect.poll(() => assetListRequests).toBeGreaterThan(0);
  const beforeDeleteRefreshes = assetListRequests;
  await page.getByRole('button', { name: /冻结全部匹配/ }).click();
  await expect(page.getByLabel('服务器选择快照').getByText('冻结快照 120 台')).toBeVisible();
  await page.getByLabel('服务器选择快照').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '提交删除任务' }).click();
  await expect(page.getByLabel('批量任务进度').getByText('删除任务：64/120')).toBeVisible();
  await expect.poll(() => deletePolls).toBeGreaterThanOrEqual(2);
  await expect(page.getByLabel('批量任务进度').getByText('删除任务：完成')).toBeVisible();
  await expect.poll(() => assetListRequests).toBeGreaterThan(beforeDeleteRefreshes);

  expect(selectionRequests).toHaveLength(1);
  expect(selectionRequests[0]).toMatchObject({ allMatching: true, conn: 'all' });
  expect(selectionRequests[0]).not.toHaveProperty('ids');
  expect(jobRequests).toHaveLength(1);
  expect(jobRequests[0]).toMatchObject({ selectionId: 'bulk-delete-selection', operation: 'delete', payload: {}, idempotencyKey: expect.any(String) });
  expect(jobRequests[0]).not.toHaveProperty('ids');
  expect(deletePolls).toBeGreaterThanOrEqual(2);
});
