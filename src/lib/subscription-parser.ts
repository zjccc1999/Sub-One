import yaml from 'js-yaml';

import { Node } from '../types';

interface ProcessOptions {
  exclude?: string;
  prependSubName?: boolean;
}

/**
 * 强大的订阅解析器
 * 支持多种格式：Base64、纯文本、YAML、Clash配置等
 * 支持协议：SS, SSR, VMess, VLESS, Trojan, Hysteria, Hysteria2, TUIC, Socks5, HTTP
 */
export class SubscriptionParser {
  supportedProtocols: string[];
  _base64Regex: RegExp;
  _whitespaceRegex: RegExp;
  _newlineRegex: RegExp;
  _nodeRegex: RegExp | null;
  _protocolRegex: RegExp;

  constructor() {
    this.supportedProtocols = [
      'ss', 'ssr', 'vmess', 'vless', 'trojan',
      'hysteria', 'hysteria2', 'hy', 'hy2',
      'tuic', 'anytls', 'socks5', 'http', 'https'
    ];

    this._base64Regex = /^[A-Za-z0-9+\/=_ -]+$/;
    this._whitespaceRegex = /\s/g;
    this._newlineRegex = /\r?\n/;
    this._nodeRegex = null;
    this._protocolRegex = /^(.*?):\/\//;
  }

  /**
   * 安全解码 Base64 字符串 (支持 UTF-8, URL-safe)
   */
  decodeBase64(str: string): string {
    if (!str) return '';

    // 移除空白字符
    let base64 = str.replace(this._whitespaceRegex, '');

    // 处理 URL-safe Base64
    base64 = base64.replace(/-/g, '+').replace(/_/g, '/');

    // 补全 padding
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }

    try {
      // 使用 TextDecoder 处理 UTF-8 字符
      const binaryString = atob(base64);
      const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      console.warn('Base64 decoding failed:', e);
      // 尝试直接返回，或者返回空字符串
      return '';
    }
  }

  /**
   * 解析订阅内容
   */
  parse(content: string, subscriptionName = ''): Node[] {
    if (!content || typeof content !== 'string') {
      return [];
    }

    const cleanedContent = content.trim();
    let nodes: Node[] = [];

    // 1. 尝试解析 YAML / Clash 配置
    if (cleanedContent.includes('proxies:') || cleanedContent.includes('nodes:') || cleanedContent.startsWith('---')) {
      try {
        nodes = this.parseYAML(cleanedContent, subscriptionName);
        if (nodes.length > 0) return nodes;
      } catch (e) {
        console.debug('YAML parsing failed, trying other methods', e);
      }
    }

    // 2. 尝试 Base64 解码
    // 移除所有空白字符进行检测
    const contentNoWhitespace = cleanedContent.replace(this._whitespaceRegex, '');
    if (this._base64Regex.test(contentNoWhitespace)) {
      try {
        const decoded = this.decodeBase64(contentNoWhitespace);
        if (decoded) {
          // 递归调用 parse，因为解码后的内容可能是 YAML 或 纯文本列表
          // 但为了防止无限递归，我们需要检查解码后的内容是否看起来像节点列表
          if (decoded.includes('proxies:') || decoded.includes('://')) {
            // 这里简单处理，直接按行解析
            const decodedLines = decoded.split(this._newlineRegex).filter(line => line.trim() !== '');
            nodes = this.parseNodeLines(decodedLines, subscriptionName);
            if (nodes.length > 0) return nodes;
          }
        }
      } catch (e) {
        console.debug('Base64 parsing failed', e);
      }
    }

    // 3. 尝试纯文本解析 (逐行解析)
    const lines = cleanedContent.split(this._newlineRegex).filter(line => line.trim() !== '');
    nodes = this.parseNodeLines(lines, subscriptionName);

    return nodes;
  }

  /**
   * 解析 YAML 格式
   */
  parseYAML(content: string, subscriptionName: string): Node[] {
    try {
      const parsed: any = yaml.load(content);
      if (!parsed || typeof parsed !== 'object') {
        return [];
      }

      if (parsed.proxies && Array.isArray(parsed.proxies)) {
        return this.parseClashProxies(parsed.proxies, subscriptionName);
      }

      // 兼容其他可能的 YAML 格式
      if (parsed.nodes && Array.isArray(parsed.nodes)) {
        // 假设 nodes 里的结构类似 Clash
        return this.parseClashProxies(parsed.nodes, subscriptionName);
      }

      return [];
    } catch (error) {
      throw error;
    }
  }

  /**
   * 解析 Clash 代理列表
   */
  parseClashProxies(proxies: any[], subscriptionName: string): Node[] {
    const nodes: Node[] = [];
    for (const proxy of proxies) {
      if (!proxy || typeof proxy !== 'object') continue;

      // 尝试将 Clash 配置转换为 URL，以便统一处理
      const url = this.convertClashProxyToUrl(proxy);
      if (url) {
        nodes.push({
          id: crypto.randomUUID(),
          name: proxy.name || '未命名节点',
          url: url,
          protocol: proxy.type?.toLowerCase() || 'unknown',
          enabled: true,
          type: 'subscription',
          subscriptionName: subscriptionName,
          originalProxy: proxy
        });
      }
    }
    return nodes;
  }

  /**
   * 将 Clash 代理对象转换为标准 URL
   */
  convertClashProxyToUrl(proxy: any): string | null {
    const type = proxy.type?.toLowerCase();
    if (!type) return null;

    switch (type) {
      case 'ss': return this.buildShadowsocksUrl(proxy);
      case 'ssr': return this.buildShadowsocksRUrl(proxy);
      case 'vmess': return this.buildVmessUrl(proxy);
      case 'vless': return this.buildVlessUrl(proxy);
      case 'trojan': return this.buildTrojanUrl(proxy);
      case 'hysteria': return this.buildHysteriaUrl(proxy);
      case 'hysteria2': return this.buildHysteria2Url(proxy);
      case 'tuic': return this.buildTuicUrl(proxy);
      case 'socks5': return this.buildSocks5Url(proxy);
      case 'anytls': return this.buildAnytlsUrl(proxy);
      case 'http': return this.buildHttpUrl(proxy);
      default: return null;
    }
  }

  // --- URL Builders for Clash Configs ---

  buildShadowsocksUrl(proxy: any): string {
    // ss://base64(method:password)@server:port#name
    // OR ss://base64(method:password@server:port)#name
    const userInfo = `${proxy.cipher}:${proxy.password}`;
    const base64User = btoa(userInfo);
    let url = `ss://${base64User}@${proxy.server}:${proxy.port}`;
    if (proxy.plugin) {
      // Handle plugins if necessary, simpler to just append params
      const params = new URLSearchParams();
      params.set('plugin', `${proxy.plugin};${proxy['plugin-opts'] ? Object.entries(proxy['plugin-opts']).map(([k, v]) => `${k}=${v}`).join(';') : ''}`);
      url += `/?${params.toString()}`;
    }
    url += `#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildShadowsocksRUrl(proxy: any): string {
    // ssr://base64(host:port:protocol:method:obfs:base64pass/?obfsparam=...&protoparam=...&remarks=...&group=...)
    const password = this.safeBtoa(proxy.password);
    const configStr = `${proxy.server}:${proxy.port}:${proxy.protocol}:${proxy.cipher}:${proxy.obfs}:${password}`;
    const base64Config = this.safeBtoa(configStr);

    const params = new URLSearchParams();
    if (proxy['obfs-param']) params.set('obfsparam', this.safeBtoa(proxy['obfs-param']));
    if (proxy['protocol-param']) params.set('protoparam', this.safeBtoa(proxy['protocol-param']));
    params.set('remarks', this.safeBtoa(proxy.name));

    return `ssr://${base64Config}/?${params.toString()}`;
  }

  buildVmessUrl(proxy: any): string {
    // VMess JSON format
    const config = {
      v: "2",
      ps: proxy.name,
      add: proxy.server,
      port: proxy.port,
      id: proxy.uuid,
      aid: proxy.alterId || 0,
      scy: proxy.cipher || 'auto',
      net: proxy.network || 'tcp',
      type: proxy.type || 'none', // header type
      host: proxy['ws-opts']?.headers?.Host || proxy.host || "",
      path: proxy['ws-opts']?.path || proxy.path || "",
      tls: proxy.tls ? "tls" : "",
      sni: proxy.servername || proxy.sni || "",
      alpn: proxy.alpn ? proxy.alpn.join(',') : "",
      fp: proxy.fingerprint || ""
    };
    return `vmess://${this.safeBtoa(JSON.stringify(config))}`;
  }

  buildVlessUrl(proxy: any): string {
    // vless://uuid@host:port?params#name
    let url = `vless://${proxy.uuid}@${proxy.server}:${proxy.port}`;
    const params = new URLSearchParams();

    params.set('type', proxy.network || 'tcp');
    if (proxy.tls) {
      params.set('security', 'tls');
      if (proxy.servername) params.set('sni', proxy.servername);
      if (proxy.fingerprint) params.set('fp', proxy.fingerprint);
      if (proxy.alpn) params.set('alpn', proxy.alpn.join(','));
      if (proxy['reality-opts']) {
        params.set('security', 'reality');
        params.set('pbk', proxy['reality-opts']['public-key']);
        params.set('sid', proxy['reality-opts']['short-id']);
      }
    }
    if (proxy.flow) params.set('flow', proxy.flow);
    if (proxy.network === 'ws') {
      if (proxy['ws-opts']?.path) params.set('path', proxy['ws-opts'].path);
      if (proxy['ws-opts']?.headers?.Host) params.set('host', proxy['ws-opts'].headers.Host);
    }
    if (proxy.network === 'grpc') {
      if (proxy['grpc-opts']?.['grpc-service-name']) params.set('serviceName', proxy['grpc-opts']['grpc-service-name']);
    }

    url += `?${params.toString()}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildTrojanUrl(proxy: any): string {
    // trojan://password@host:port?params#name
    let url = `trojan://${proxy.password}@${proxy.server}:${proxy.port}`;
    const params = new URLSearchParams();

    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.alpn) params.set('alpn', proxy.alpn.join(','));
    if (proxy.skip_cert_verify) params.set('allowInsecure', '1');
    if (proxy.network === 'ws') {
      params.set('type', 'ws');
      if (proxy['ws-opts']?.path) params.set('path', proxy['ws-opts'].path);
      if (proxy['ws-opts']?.headers?.Host) params.set('host', proxy['ws-opts'].headers.Host);
    }
    if (proxy.network === 'grpc') {
      params.set('type', 'grpc');
      if (proxy['grpc-opts']?.['grpc-service-name']) params.set('serviceName', proxy['grpc-opts']['grpc-service-name']);
    }

    url += `?${params.toString()}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildHysteriaUrl(proxy: any): string {
    // hysteria://host:port?params#name
    let url = `hysteria://${proxy.server}:${proxy.port}`;
    const params = new URLSearchParams();

    if (proxy.auth_str) params.set('auth', proxy.auth_str);
    if (proxy.protocol) params.set('protocol', proxy.protocol);
    if (proxy.up) params.set('upmbps', proxy.up);
    if (proxy.down) params.set('downmbps', proxy.down);
    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.alpn) params.set('alpn', proxy.alpn.join(','));
    if (proxy.obfs) params.set('obfs', proxy.obfs);

    url += `?${params.toString()}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildHysteria2Url(proxy: any): string {
    // hysteria2://password@host:port?params#name
    let url = `hysteria2://${proxy.password}@${proxy.server}:${proxy.port}`;
    const params = new URLSearchParams();

    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.obfs) {
      params.set('obfs', proxy.obfs);
      if (proxy['obfs-password']) params.set('obfs-password', proxy['obfs-password']);
    }

    url += `?${params.toString()}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildTuicUrl(proxy: any): string {
    // tuic://uuid:password@host:port?params#name
    let url = `tuic://${proxy.uuid}:${proxy.password}@${proxy.server}:${proxy.port}`;
    const params = new URLSearchParams();

    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.alpn) params.set('alpn', proxy.alpn.join(','));
    if (proxy.congestion_control) params.set('congestion_control', proxy.congestion_control);
    if (proxy.udp_relay_mode) params.set('udp_relay_mode', proxy.udp_relay_mode);

    url += `?${params.toString()}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildSocks5Url(proxy: any): string {
    let url = `socks5://`;
    if (proxy.username && proxy.password) {
      url += `${proxy.username}:${proxy.password}@`;
    }
    url += `${proxy.server}:${proxy.port}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildAnytlsUrl(proxy: any): string {
    // anytls://uuid:password@host:port?params#name
    let url = `anytls://${proxy.uuid || ''}:${proxy.password || ''}@${proxy.server}:${proxy.port}`;
    const params = new URLSearchParams();

    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.alpn) params.set('alpn', proxy.alpn.join(','));
    if (proxy.fingerprint) params.set('fp', proxy.fingerprint);
    if (proxy.client) params.set('client', proxy.client);

    url += `?${params.toString()}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  buildHttpUrl(proxy: any): string {
    let url = `http://`;
    if (proxy.username && proxy.password) {
      url += `${proxy.username}:${proxy.password}@`;
    }
    url += `${proxy.server}:${proxy.port}#${encodeURIComponent(proxy.name)}`;
    return url;
  }

  /**
   * 解析节点链接列表
   */
  parseNodeLines(lines: string[], subscriptionName: string): Node[] {
    const nodes: Node[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const node = this.parseNodeUrl(trimmed, subscriptionName);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  /**
   * 解析单个节点 URL
   */
  parseNodeUrl(url: string, subscriptionName: string): Node | null {
    if (!url.includes('://')) return null;

    const protocolMatch = url.match(this._protocolRegex);
    if (!protocolMatch) return null;

    const protocol = protocolMatch[1].toLowerCase();

    // 基础节点结构
    const node: Node = {
      id: crypto.randomUUID(),
      name: '未命名节点',
      url: url,
      protocol: protocol,
      enabled: true,
      type: 'subscription',
      subscriptionName: subscriptionName
    };

    // 提取名称
    const hashIndex = url.indexOf('#');
    if (hashIndex !== -1) {
      node.name = decodeURIComponent(url.substring(hashIndex + 1));
    } else {
      // 尝试从具体协议中提取名称
      node.name = this.extractNameFromProtocol(url, protocol);
    }

    // 验证协议是否支持
    if (!this.supportedProtocols.includes(protocol) && !['hy', 'hy2'].includes(protocol)) {
      // 虽然不在显式支持列表，但如果是有效的 URL，我们仍然保留，标记为 unknown 或 generic
      // 但为了严谨，这里可以返回 null 或者保留
      // 用户要求支持所有协议，所以最好保留
    }

    return node;
  }

  extractNameFromProtocol(url: string, protocol: string): string {
    try {
      switch (protocol) {
        case 'vmess': {
          const base64 = url.replace('vmess://', '');
          const config = JSON.parse(this.decodeBase64(base64));
          return config.ps || config.add || 'VMess节点';
        }
        case 'ssr': {
          // ssr://base64(...)
          const base64 = url.replace('ssr://', '');
          const decoded = this.decodeBase64(base64);
          // host:port:protocol:method:obfs:base64pass/?params
          const parts = decoded.split('/?');
          if (parts.length > 1) {
            const params = new URLSearchParams(parts[1]);
            if (params.get('remarks')) {
              return this.decodeBase64(params.get('remarks')!);
            }
          }
          return 'SSR节点';
        }
        // 其他协议通常在 hash 中，如果 hash 不存在，则使用 host
        default: {
          try {
            const u = new URL(url);
            return u.hostname;
          } catch {
            return `${protocol}节点`;
          }
        }
      }
    } catch {
      return `${protocol}节点`;
    }
  }

  /**
   * 辅助方法：URL-safe Base64 编码
   */
  safeBtoa(str: string): string {
    try {
      return btoa(unescape(encodeURIComponent(str)));
    } catch {
      return btoa(str);
    }
  }

  /**
   * 处理节点：过滤和重命名
   */
  processNodes(nodes: Node[], subName: string, options: ProcessOptions = {}): Node[] {
    let processed = nodes;

    // 1. 处理 Include/Exclude 规则
    if (options.exclude && options.exclude.trim()) {
      const rules = options.exclude.trim().split('\n').map(r => r.trim()).filter(Boolean);
      const keepRules = rules.filter(r => r.toLowerCase().startsWith('keep:'));

      if (keepRules.length > 0) {
        // 白名单模式
        const nameRegexParts: string[] = [];
        const protocolsToKeep = new Set();
        keepRules.forEach(rule => {
          const content = rule.substring(5).trim(); // 'keep:'.length
          if (content.toLowerCase().startsWith('proto:')) {
            content.substring(6).split(',').forEach(p => protocolsToKeep.add(p.trim().toLowerCase()));
          } else {
            nameRegexParts.push(content);
          }
        });
        const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;

        processed = processed.filter(node => {
          if (protocolsToKeep.has((node.protocol || '').toLowerCase())) return true;
          if (nameRegex && nameRegex.test(node.name)) return true;
          return false;
        });
      } else {
        // 黑名单模式
        const protocolsToExclude = new Set();
        const nameRegexParts: string[] = [];
        rules.forEach(rule => {
          if (rule.toLowerCase().startsWith('proto:')) {
            rule.substring(6).split(',').forEach(p => protocolsToExclude.add(p.trim().toLowerCase()));
          } else {
            nameRegexParts.push(rule);
          }
        });
        const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;

        processed = processed.filter(node => {
          if (protocolsToExclude.has((node.protocol || '').toLowerCase())) return false;
          if (nameRegex && nameRegex.test(node.name)) return false;
          return true;
        });
      }
    }

    // 2. 添加前缀
    if (options.prependSubName && subName) {
      processed = processed.map(node => {
        if (!node.name.startsWith(subName)) {
          node.name = `${subName} - ${node.name}`;
          // 更新 URL 中的 hash
          const hashIndex = node.url.lastIndexOf('#');
          const baseUrl = hashIndex !== -1 ? node.url.substring(0, hashIndex) : node.url;
          node.url = `${baseUrl}#${encodeURIComponent(node.name)}`;
        }
        return node;
      });
    }

    return processed;
  }
}

// 导出单例实例
export const subscriptionParser = new SubscriptionParser();
