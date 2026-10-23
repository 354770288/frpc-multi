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
    ]});
    if(url.pathname==='/api/probe/nodes/execution-policy')return json({configured:true,primaryNodeId:'remote',backupNodeIds:['backup'],suggestedPrimaryNodeId:'remote'});
    if(url.pathname==='/api/probe/nodes/failovers'){
      const page=Number(url.searchParams.get('page') || 1);
      return json({items:[{id:page,taskId:`task-${page}`,jobId:'job-qa',fromNodeId:'remote',toNodeId:'backup',generation:page,reason:'primary_offline',transferredAt:'2026-10-23T10:00:00+00:00'}],page,pageSize:20,total:21});
    }
    if(url.pathname==='/api/probe/servers/groups')return json([{name:'QA',color:''}]);
    if(url.pathname==='/api/probe/tags/categories')return json({items:[{id:'region',name:'地区'},{id:'carrier',name:'线路'}]});
    if(url.pathname==='/api/probe/tags')return json({items:[{id:'tag-region-cn',categoryId:'region',category:'地区',name:'CN',serverCount:1},{id:'tag-carrier-cn',categoryId:'carrier',category:'线路',name:'CN',serverCount:1}]});
    if(url.pathname==='/api/probe/servers/facets')return json({labels:[{label:'legacy',count:1}],tagItems:[{tagId:'tag-region-cn',categoryId:'region',category:'地区',name:'CN',count:1},{tagId:'tag-carrier-cn',categoryId:'carrier',category:'线路',name:'CN',count:1}],groups:[]});
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
    if(url.pathname==='/api/probe/jobs/created-qa-job')return json({id:'created-qa-job',mode:'full',state:'running',counts:{pending:3},taskTotal:3,filteredTaskTotal:3,nodeIds:['remote'],stageCounts:[],progress:{scanned:0,foundCount:0},createdAt:new Date().toISOString(),tasks:[],page:1,pageSize:200});
    return json({});
  });
});

test('new test requires an explicit target and review before submitting', async ({page}) => {
  let submissions=0;let submitted:Record<string,unknown>|null=null;
  page.on('request',(request)=>{if(request.url().endsWith('/api/probe/jobs') && request.method()==='POST'){submissions++;submitted=request.postDataJSON();}});
  await page.goto('/tests/new');
  await expect(page.getByRole('heading',{name:'新建测试',level:2})).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  expect(submissions).toBe(0);
  await page.getByLabel('目标范围').selectOption('group');
  await page.getByLabel('分组').selectOption('QA');
  await expect(page.getByText('将测试 1 个不同端点')).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await expect(page.getByText(/主节点：国内测试节点/)).toBeVisible();
  await expect(page.getByText(/备用节点顺序：备用测试节点/)).toBeVisible();
  await page.getByRole('button',{name:'下一步'}).click();
  await expect(page.getByText('目标：1 个端点 · 分组 QA')).toBeVisible();
  expect(submissions).toBe(0);
  await page.getByRole('button',{name:'提交测试'}).click();
  await expect(page).toHaveURL(/\/tests\/created-qa-job/);
  expect(submissions).toBe(1);
  expect(submitted).toMatchObject({mode:'full',ips:['192.0.2.1:7000'],targetScope:'explicit'});
  expect(submitted).not.toHaveProperty('nodeIds');
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
  await expect(page).toHaveURL(/\/tests\/new\?group=QA&nodeId=remote/);
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
    if(url.pathname==='/api/probe/servers/batch-update' && request.method()==='POST')assignment=request.postDataJSON();
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
  expect(assignment).toMatchObject({ids:[1],addTagIds:['tag-region-cn'],removeTagIds:[]});
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
  await page.goto('/audit');
  await expect(page.getByText('205 条匹配')).toBeVisible();
  await page.goto('/results?kind=route&nodeId=remote&ip=192.0.2.1');
  await expect(page.getByText('路由 · 共 205 条')).toBeVisible();
  await expect(page.getByLabel('结果来源')).toHaveValue('remote');
  await expect(page.getByText('192.0.2.1:7000')).toBeVisible();
  await expect(page.getByRole('button',{name:'来源对比'})).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('路由 · 共 205 条')).toBeVisible();
  await expect(page).toHaveURL(/nodeId=remote/);
});

test('unknown domain health is not counted as healthy',async ({page})=>{
  await page.goto('/lb');
  await expect(page.getByText(/0\/1 已确认健康 · 1 待检查/)).toBeVisible();
  await page.screenshot({path:'test-results/lb-unknown-1280.png',fullPage:true});
  await expect(page.getByRole('link',{name:'测量此分组 →'})).toHaveAttribute('href',/\/tests\/new\?/);
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
