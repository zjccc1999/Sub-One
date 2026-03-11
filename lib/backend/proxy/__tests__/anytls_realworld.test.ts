import { describe, expect, it } from 'vitest';
import { parse, convert } from '../index';

const REAL_URIS = [
  'anytls://72f8ffe2-e377-466f-8e0d-3b9af6c49a4f@usall.9966663.xyz:20131/?insecure=1&sni=usall.9966663.xyz#%F0%9F%87%BA%F0%9F%87%B8%20SKYLUMO.CC',
  'anytls://72f8ffe2-e377-466f-8e0d-3b9af6c49a4f@hkv4.9966663.xyz:20131/?insecure=1&sni=hkv4.9966663.xyz#%F0%9F%87%AD%F0%9F%87%B0%20%E4%B8%AD%E5%9B%BD-%E9%A6%99%E6%B8%AF-01',
  'anytls://72f8ffe2-e377-466f-8e0d-3b9af6c49a4f@usall.9966663.xyz:20135/?insecure=1&sni=co-358d29-330.9966663.xyz#US-Multi',
];

describe('Real Subscription AnyTLS Validation', () => {
  it('should parse real anytls URIs correctly', () => {
    const nodes = parse(REAL_URIS.join('\n'));
    expect(nodes.length).toBe(3);
    nodes.forEach(n => {
      expect(n.type).toBe('anytls');
      expect(n.password).toBe('72f8ffe2-e377-466f-8e0d-3b9af6c49a4f');
      expect(n.tls).toBe(true);
      expect(n['skip-cert-verify']).toBe(true);
    });
    expect(nodes[0].server).toBe('usall.9966663.xyz');
    expect(nodes[0].port).toBe(20131);
    expect(nodes[0].sni).toBe('usall.9966663.xyz');
    expect(nodes[0].name).toBe('🇺🇸 SKYLUMO.CC');
    expect(nodes[1].name).toBe('🇭🇰 中国-香港-01');
    expect(nodes[2].sni).toBe('co-358d29-330.9966663.xyz');
  });

  it('should convert real anytls to Surge format', async () => {
    const nodes = parse(REAL_URIS[0]);
    const r = await convert(nodes, 'surge');
    expect(r).toContain('anytls');
    expect(r).toContain('usall.9966663.xyz');
    expect(r).toContain('skip-cert-verify=true');
    expect(r).toContain('sni=usall.9966663.xyz');
    console.log('[Surge]', r);
  });

  it('should convert real anytls to Loon format', async () => {
    const nodes = parse(REAL_URIS[0]);
    const r = await convert(nodes, 'loon');
    expect(r).toContain('anytls');
    expect(r).toContain('usall.9966663.xyz');
    console.log('[Loon]', r);
  });

  it('should convert real anytls to Clash Meta YAML', async () => {
    const nodes = parse(REAL_URIS[0]);
    const r = await convert(nodes, 'clash-meta');
    expect(r).toContain('type: anytls');
    expect(r).toContain('password');
    console.log('[ClashMeta]', r);
  });

  it('should convert real anytls to Singbox JSON', async () => {
    const nodes = parse(REAL_URIS[0]);
    const r = await convert(nodes, 'singbox');
    const parsed = JSON.parse(r);
    expect(parsed.outbounds[0].type).toBe('anytls');
    expect(parsed.outbounds[0].password).toBe('72f8ffe2-e377-466f-8e0d-3b9af6c49a4f');
    expect(parsed.outbounds[0].tls.server_name).toBe('usall.9966663.xyz');
    console.log('[Singbox]', JSON.stringify(parsed.outbounds[0], null, 2));
  });

  it('should roundtrip: parse then re-encode to URI', async () => {
    const nodes = parse(REAL_URIS[0]);
    const r = await convert(nodes, 'uri');
    expect(r).toMatch(/^anytls:\/\//);
    expect(r).toContain('usall.9966663.xyz');
    expect(r).toContain('insecure=1');
    console.log('[URI roundtrip]', r);
  });
});
