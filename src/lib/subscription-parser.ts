import yaml from 'js-yaml';

interface Node {
  id: string;
  name: string;
  url: string;
  protocol: string;
  enabled: boolean;
  type: string;
  subscriptionName: string;
  originalProxy?: any;
}

interface ProcessOptions {
  exclude?: string;
  prependSubName?: boolean;
}

// 增强：Clash 代理配置的类型定义，包含 host 字段兼容
interface ClashProxy {
  name: string;
  type: string;
  server?: string;
  host?: string; // 兼容非标准字段
  port: number | string;
  uuid?: string;
  password?: string;
  cipher?: string;
  udp?: boolean | number;
  tls?: boolean;
  sni?: string;
  peer?: string; // 兼容 AnyTLS peer 字段
  network?: string;
  'client-fingerprint'?: string;
  allowInsecure?: boolean | number; // 兼容 0/1 或 true/false
  'skip-cert-verify'?: boolean;
  'reality-opts'?: {
    'public-key': string;
    'short-id': string;
  };
  'ws-opts'?: {
    path?: string;
    headers?: { Host?: string };
  };
  'grpc-opts'?: {
    'grpc-service-name'?: string;
  };
  [key: string]: any;
}

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
      'tuic', 'anytls', 'socks5'
    ];

    this._base64Regex = /^[A-Za-z0-9+\/=]+$/;
    this._whitespaceRegex = /\s/g;
    this._newlineRegex = /\r?\n/;
    this._nodeRegex = null;
    this._protocolRegex = /^(.*?):\/\//;
  }

  decodeBase64(str: string) {
    try {
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(str, 'base64').toString('utf8');
      }
      const binaryString = atob(str);
      const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      console.warn('Base64 decoding failed, trying permissive mode:', e);
      try { return atob(str); } catch (e2) { return str; }
    }
  }

  encodeBase64(str: string) {
    try {
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(str, 'utf8').toString('base64');
      }
      const bytes = new TextEncoder().encode(str);
      const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
      return btoa(binString);
    } catch (e) {
      return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => {
        return String.fromCharCode(parseInt(p1, 16));
      }));
    }
  }

  parse(content: string, subscriptionName = ''): Node[] {
    if (!content || typeof content !== 'string') return [];

    let methods: (() => Node[])[] = [];

    // 1. 优先检测 YAML (包含 proxies/nodes 关键字)
    if (content.includes('proxies:') || content.includes('nodes:') || content.includes('"type":')) {
      methods.push(() => this.parseYAML(content, subscriptionName));
      methods.push(() => this.parseClashConfig(content, subscriptionName));
    }

    // 2. Base64 检测
    const cleanedContent = content.replace(this._whitespaceRegex, '');
    if (this._base64Regex.test(cleanedContent) && cleanedContent.length > 20) {
      methods.push(() => this.parseBase64(content, subscriptionName));
    }

    // 3. 纯文本
    methods.push(() => this.parsePlainText(content, subscriptionName));

    for (const method of methods) {
      try {
        const result = method();
        if (result && result.length > 0) {
          console.log(`解析成功，找到 ${result.length} 个节点`);
          return result;
        }
      } catch (error) { continue; }
    }
    return [];
  }

  parseBase64(content: string, subscriptionName: string): Node[] {
    const cleanedContent = content.replace(this._whitespaceRegex, '');
    try {
      const decodedContent = this.decodeBase64(cleanedContent);
      const decodedLines = decodedContent.split(this._newlineRegex).filter(line => line.trim() !== '');
      // 如果解码后是 JSON/YAML 内容，递归调用 parse
      if (decodedContent.includes('proxies:') || decodedContent.trim().startsWith('{')) {
         return this.parse(decodedContent, subscriptionName);
      }
      return this.parseNodeLines(decodedLines, subscriptionName);
    } catch (error: any) {
      throw new Error(`Base64解码失败: ${error.message}`);
    }
  }

  parseYAML(content: string, subscriptionName: string): Node[] {
    try {
      const parsed: any = yaml.load(content);
      if (!parsed || typeof parsed !== 'object') throw new Error('无效的YAML/JSON格式');

      // 支持直接解析单个节点对象
      if (parsed.type && (parsed.server || parsed.host) && parsed.port) {
         return this.parseClashProxies([parsed], subscriptionName);
      }

      if (parsed.proxies && Array.isArray(parsed.proxies)) {
        return this.parseClashProxies(parsed.proxies, subscriptionName);
      }
      if (parsed.nodes && Array.isArray(parsed.nodes)) {
        return this.parseGenericNodes(parsed.nodes, subscriptionName);
      }
      throw new Error('不支持的YAML格式');
    } catch (error: any) {
      throw new Error(`YAML解析失败: ${error.message}`);
    }
  }

  parseClashConfig(content: string, subscriptionName: string): Node[] {
    return this.parseYAML(content, subscriptionName);
  }

  parsePlainText(content: string, subscriptionName: string): Node[] {
    const lines = content.split(this._newlineRegex).filter(line => line.trim() !== '');
    const nodeLines = lines.filter(line => this.isNodeUrl(line));
    if (nodeLines.length === 0) throw new Error('未找到有效的节点链接');
    return this.parseNodeLines(nodeLines, subscriptionName);
  }

  parseClashProxies(proxies: any[], subscriptionName: string): Node[] {
    const nodes: Node[] = [];
    for (const proxy of proxies) {
      if (!proxy || typeof proxy !== 'object') continue;
      try {
        const nodeUrl = this.convertClashProxyToUrl(proxy);
        if (nodeUrl) {
          nodes.push({
            id: crypto.randomUUID(),
            name: proxy.name || proxy.title || '未命名节点', // 兼容 title 字段
            url: nodeUrl,
            protocol: proxy.type?.toLowerCase() || 'unknown',
            enabled: true,
            type: 'subscription',
            subscriptionName: subscriptionName,
            originalProxy: proxy
          });
        }
      } catch (error) {
        console.warn(`解析代理配置失败: ${proxy.name}`, error);
      }
    }
    return nodes;
  }

  convertClashProxyToUrl(proxy: ClashProxy) {
    const type = proxy.type?.toLowerCase();
    // 关键修复：兼容 host 字段作为 server
    const server = proxy.server || proxy.host;
    const port = proxy.port;

    if (!server || !port) return null;

    const proxyTypeHandlers = new Map([
      ['vmess', () => this.buildVmessUrl(proxy)],
      ['vless', () => this.buildVlessUrl(proxy)],
      ['trojan', () => this.buildTrojanUrl(proxy)],
      ['ss', () => this.buildShadowsocksUrl(proxy)],
      ['ssr', () => this.buildShadowsocksRUrl(proxy)],
      ['hysteria', () => this.buildHysteriaUrl(proxy)],
      ['hysteria2', () => this.buildHysteriaUrl(proxy)],
      ['tuic', () => this.buildTUICUrl(proxy)],
      ['anytls', () => this.buildAnyTLSUrl(proxy)], // 新增 AnyTLS
      ['socks5', () => this.buildSocks5Url(proxy)]
    ]);

    const handler = proxyTypeHandlers.get(type);
    return handler ? handler() : null;
  }

  // --- 新增：AnyTLS URL 构建方法 ---
  buildAnyTLSUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    
    // 映射 allowInsecure/skip-cert-verify -> insecure
    if (proxy.allowInsecure || proxy['skip-cert-verify']) {
        params.set('insecure', '1');
    }
    
    // 映射 peer -> sni
    if (proxy.peer || proxy.sni) {
        params.set('sni', proxy.peer || proxy.sni);
    }

    // 构建认证部分 (uuid:password)
    let userInfo = '';
    if (proxy.uuid && proxy.password) {
        userInfo = `${proxy.uuid}:${proxy.password}`;
    } else if (proxy.password) {
        userInfo = proxy.password;
    } else if (proxy.uuid) {
        userInfo = proxy.uuid;
    }

    const address = `${proxy.server || proxy.host}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || proxy.title || 'AnyTLS节点');

    // 格式：anytls://userInfo@host:port?params#name
    let url = `anytls://`;
    if (userInfo) url += `${userInfo}@`;
    url += `${address}`;
    if (params.toString()) url += `?${params.toString()}`;
    url += `#${hash}`;

    return url;
  }

  buildVmessUrl(proxy: ClashProxy) {
    const config = {
      v: '2',
      ps: proxy.name || 'VMess节点',
      add: proxy.server || proxy.host,
      port: proxy.port,
      id: proxy.uuid,
      aid: proxy.alterId || 0,
      net: proxy.network || 'tcp',
      type: proxy.type || 'none',
      host: proxy['ws-opts']?.headers?.Host || proxy.host || '',
      path: proxy['ws-opts']?.path || proxy.path || '',
      tls: proxy.tls ? 'tls' : 'none'
    };
    const jsonStr = JSON.stringify(config);
    const base64 = this.encodeBase64(jsonStr);
    return `vmess://${base64}`;
  }

  buildVlessUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    params.set('security', proxy.tls ? 'tls' : 'none');
    
    const network = proxy.network || 'tcp';
    params.set('type', network);

    if (network === 'ws') {
      if (proxy['ws-opts']?.path) params.set('path', proxy['ws-opts'].path);
      if (proxy['ws-opts']?.headers?.Host) params.set('host', proxy['ws-opts'].headers.Host);
    } else if (network === 'grpc') {
      if (proxy['grpc-opts']?.['grpc-service-name']) params.set('serviceName', proxy['grpc-opts']['grpc-service-name']);
    }

    if (proxy['reality-opts'] || (proxy['client-fingerprint'] && proxy.tls)) {
       params.set('security', 'reality');
       if (proxy['reality-opts']?.['public-key']) params.set('pbk', proxy['reality-opts']['public-key']);
       if (proxy['reality-opts']?.['short-id']) params.set('sid', proxy['reality-opts']['short-id']);
       if (proxy.flow) params.set('flow', proxy.flow);
    }
    
    if (proxy['client-fingerprint']) params.set('fp', proxy['client-fingerprint']);
    if (proxy.sni || proxy.servername) params.set('sni', proxy.sni || proxy.servername);

    const userInfo = proxy.uuid;
    const address = `${proxy.server || proxy.host}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || 'VLESS节点');

    return `vless://${userInfo}@${address}?${params.toString()}#${hash}`;
  }

  buildTrojanUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    if (proxy.sni || proxy.peer) params.set('sni', proxy.sni || proxy.peer);
    if (proxy.network === 'ws') params.set('type', 'ws');
    if (proxy['ws-opts']?.path) params.set('path', proxy['ws-opts'].path);
    if (proxy['ws-opts']?.headers?.Host) params.set('host', proxy['ws-opts'].headers.Host);
    if (proxy.allowInsecure) params.set('allowInsecure', '1');

    const userInfo = proxy.password;
    const address = `${proxy.server || proxy.host}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || 'Trojan节点');

    return `trojan://${userInfo}@${address}?${params.toString()}#${hash}`;
  }

  buildShadowsocksUrl(proxy: ClashProxy) {
    const auth = `${proxy.cipher}:${proxy.password}`;
    const base64 = this.encodeBase64(auth);
    const hash = encodeURIComponent(proxy.name || 'SS节点');
    return `ss://${base64}@${proxy.server || proxy.host}:${proxy.port}#${hash}`;
  }

  buildShadowsocksRUrl(proxy: ClashProxy) {
    const configStr = [
      proxy.server || proxy.host,
      proxy.port,
      proxy.protocol || 'origin',
      proxy.cipher,
      proxy.obfs || 'plain',
      this.encodeBase64(proxy.password || '')
    ].join(':');
    const query = new URLSearchParams();
    if (proxy['protocol-param']) query.set('protoparam', this.encodeBase64(proxy['protocol-param']));
    if (proxy['obfs-param']) query.set('obfsparam', this.encodeBase64(proxy['obfs-param']));
    if (proxy.name) query.set('remarks', this.encodeBase64(proxy.name));
    return `ssr://${this.encodeBase64(configStr)}/?${query.toString()}`;
  }

  buildHysteriaUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    if (proxy.protocol) params.set('protocol', proxy.protocol);
    if (proxy.sni || proxy.peer) params.set('sni', proxy.sni || proxy.peer);
    if (proxy.auth || proxy.password) params.set('auth', proxy.auth || proxy.password);
    if (proxy.alpn) params.set('alpn', Array.isArray(proxy.alpn) ? proxy.alpn.join(',') : proxy.alpn);
    if (proxy.up) params.set('up', proxy.up);
    if (proxy.down) params.set('down', proxy.down);
    if (proxy['skip-cert-verify'] || proxy.allowInsecure) params.set('insecure', '1');

    const address = `${proxy.server || proxy.host}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || 'Hysteria节点');
    const scheme = (proxy.type === 'hysteria2') ? 'hysteria2' : 'hysteria';
    return `${scheme}://${address}?${params.toString()}#${hash}`;
  }

  buildTUICUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.alpn) params.set('alpn', Array.isArray(proxy.alpn) ? proxy.alpn.join(',') : proxy.alpn);
    if (proxy['skip-cert-verify']) params.set('insecure', '1');
    const userInfo = `${proxy.uuid}:${proxy.password}`;
    const address = `${proxy.server || proxy.host}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || 'TUIC节点');
    return `tuic://${userInfo}@${address}?${params.toString()}#${hash}`;
  }

  buildSocks5Url(proxy: ClashProxy) {
    let auth = '';
    if (proxy.username && proxy.password) auth = `${proxy.username}:${proxy.password}@`;
    const hash = encodeURIComponent(proxy.name || 'Socks5节点');
    return `socks5://${auth}${proxy.server || proxy.host}:${proxy.port}#${hash}`;
  }

  parseGenericNodes(nodes: any[], subscriptionName: string): Node[] {
    return nodes.map(node => ({
      id: crypto.randomUUID(),
      name: node.name || '未命名节点',
      url: node.url || '',
      protocol: node.protocol || 'unknown',
      enabled: true,
      type: 'subscription',
      subscriptionName: subscriptionName
    }));
  }

  parseNodeLines(lines: string[], subscriptionName: string): Node[] {
    return lines
      .filter(line => this.isNodeUrl(line))
      .map(line => this.parseNodeLine(line, subscriptionName))
      .filter((node): node is Node => node !== null);
  }

  parseNodeLine(line: string, subscriptionName: string): Node | null {
    if (!this._nodeRegex) {
      this._nodeRegex = new RegExp(`^(${this.supportedProtocols.join('|')}):\/\/`);
    }

    if (!this._nodeRegex.test(line)) return null;

    let name = '';
    const hashIndex = line.lastIndexOf('#');
    if (hashIndex !== -1) name = decodeURIComponent(line.substring(hashIndex + 1) || '');
    if (!name) name = this.extractNodeNameFromUrl(line);

    const protocol = line.match(this._nodeRegex)?.[1] || 'unknown';

    return {
      id: crypto.randomUUID(),
      name: name || '未命名节点',
      url: line,
      protocol: protocol,
      enabled: true,
      type: 'subscription',
      subscriptionName: subscriptionName
    };
  }

  extractNodeNameFromUrl(url: string) {
    try {
      const hashIndex = url.lastIndexOf('#');
      if (hashIndex > -1) return decodeURIComponent(url.slice(hashIndex + 1));
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch { return '未命名节点'; }
  }

  isNodeUrl(line: string) {
    if (!this._nodeRegex) {
      this._nodeRegex = new RegExp(`^(${this.supportedProtocols.join('|')}):\/\/`);
    }
    return this._nodeRegex.test(line.trim());
  }

  getSupportedProtocols() { return [...this.supportedProtocols]; }

  processNodes(nodes: Node[], subName: string, options: ProcessOptions = {}): Node[] {
    let processed = nodes;
    if (options.exclude && options.exclude.trim()) {
      const rules = options.exclude.trim().split('\n').map(r => r.trim()).filter(Boolean);
      const keepRules = rules.filter(r => r.toLowerCase().startsWith('keep:'));
      if (keepRules.length > 0) {
        const nameRegexParts: string[] = [];
        const protocolsToKeep = new Set();
        keepRules.forEach(rule => {
          const content = rule.substring(5).trim();
          if (content.toLowerCase().startsWith('proto:')) {
            content.substring(6).split(',').forEach(p => protocolsToKeep.add(p.trim().toLowerCase()));
          } else { nameRegexParts.push(content); }
        });
        const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;
        processed = processed.filter(node => {
            if (protocolsToKeep.has(node.protocol)) return true;
            return nameRegex ? nameRegex.test(node.name) : false;
        });
      } else {
        const protocolsToExclude = new Set();
        const nameRegexParts: string[] = [];
        rules.forEach(rule => {
          if (rule.toLowerCase().startsWith('proto:')) {
            rule.substring(6).split(',').forEach(p => protocolsToExclude.add(p.trim().toLowerCase()));
          } else { nameRegexParts.push(rule); }
        });
        const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;
        processed = processed.filter(node => {
          if (protocolsToExclude.has(node.protocol)) return false;
          return nameRegex ? !nameRegex.test(node.name) : true;
        });
      }
    }
    if (options.prependSubName && subName) {
      processed = processed.map(node => {
        if (!node.name.startsWith(subName)) {
          node.name = `${subName} - ${node.name}`;
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

export const subscriptionParser = new SubscriptionParser();
