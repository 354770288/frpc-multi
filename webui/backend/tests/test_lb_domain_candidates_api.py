import importlib
import unittest
from contextlib import nullcontext
from unittest.mock import patch

from tests import test_lb as legacy_lb
from tests.test_lb_domain_membership_runtime import FakeCloudflare
from app.probe.store import ProbeStore
from app.lb.health import PoolHealthMonitor


class DomainCandidatesApiTests(unittest.TestCase):
    load_lb_app = staticmethod(legacy_lb.LbApiTests.load_lb_app)

    def setUp(self):
        self.client, self.headers = legacy_lb.LbApiTests.make_client(self)
        self.probe = ProbeStore(self.db_path)
        self.first = self.probe.create_server(ip='192.0.2.10')
        self.second = self.probe.create_server(ip='192.0.2.20')
        response = self.client.post('/api/lb/domains', headers=self.headers, json={
            'name': 'manual.example.com', 'zoneId': 'zone', 'zoneName': 'example.com',
            'serverIds': [self.first.id],
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.domain = response.json()
        self.base = f'/api/lb/domains/{self.domain["id"]}'

    def test_membership_paging_atomic_validation_and_detached_group(self):
        self.assertEqual(self.domain['poolSize'], 1)
        self.assertEqual(self.domain['group'], '')
        response = self.client.post(self.base + '/servers', headers=self.headers,
                                    json={'serverIds': [self.second.id, 999999]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get(self.base + '/servers', headers=self.headers).json()['total'], 1)
        self.assertEqual(self.client.post(self.base + '/servers', headers=self.headers,
                                         json={'serverIds': [self.second.id]}).status_code, 200)
        page = self.client.get(self.base + '/servers?page=2&pageSize=1', headers=self.headers).json()
        self.assertEqual((page['total'], page['pageSize'], len(page['items'])), (2, 1, 1))
        self.assertEqual(page['items'][0]['id'], self.second.id)
        self.assertIsNone(page['items'][0]['latestSpeed'])
        self.assertEqual(self.client.get(self.base + '/servers?pageSize=201', headers=self.headers).status_code, 422)
        bad = self.client.post(self.base + '/servers', headers=self.headers, json={'serverIds': [True]})
        self.assertEqual(bad.status_code, 422)
        deleted = self.client.request('DELETE', self.base + '/servers', headers=self.headers,
                                      json={'serverIds': [self.first.id]})
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()['total'], 1)

    def test_manual_switch_persists_pin_and_rejects_nonmember_without_dns_writes(self):
        self.client.put('/api/lb/cloudflare', headers=self.headers, json={'token': 'test-token'})
        router = importlib.import_module('app.lb.router')
        monitor = PoolHealthMonitor()
        monitor._record(self.first.ip, 7000, True, 'healthy')
        cf = FakeCloudflare()
        with patch.object(router, '_cf_client', side_effect=lambda _: nullcontext(cf)), \
             patch('app.lb.syncer._default_monitor', return_value=monitor):
            bad = self.client.post(self.base + '/switch', headers=self.headers,
                                   json={'serverId': self.second.id})
            self.assertEqual(bad.status_code, 200, bad.text)
            self.assertFalse(bad.json()['ok'])
            self.assertEqual(cf.calls, [])
            response = self.client.post(self.base + '/switch', headers=self.headers,
                                        json={'serverId': self.first.id})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()['ok'])
        domains = self.client.get('/api/lb/domains', headers=self.headers).json()
        self.assertEqual(domains[0]['preferredServerId'], self.first.id)
        self.assertEqual(domains[0]['currentIp'], self.first.ip)
        member = self.client.get(self.base + '/servers', headers=self.headers).json()['items'][0]
        self.assertTrue(member['current'])
        self.assertTrue(member['preferred'])
