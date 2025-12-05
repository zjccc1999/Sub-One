没问题。针对刚才分析的 VLESS Reality 支持缺失、URL 构建不标准、类型安全以及性能优化这几个痛点，我重构了这个文件。
主要修改点：
 * 新增 VLESS Reality 支持：在 buildVlessUrl 中增加了对 reality-opts（公钥 pbk、Short ID sid）和指纹 client-fingerprint (fp) 的提取。
 * 标准化 URL 构建：全面改用 URLSearchParams 处理查询参数，不再手动拼接字符串，解决特殊字符（如空格、符号）转义问题。
 * 类型增强：增加了 ClashProxy 接口定义，代替原来的 any，让代码维护更安全。
 * 解析逻辑优化：在 parse 中增加了简单的“嗅探”逻辑，如果是 proxies: 开头直接走 YAML 解析，避免无效的 Base64 计算。
 * UTF-8 编码修复：优化了 Base64 编码/解码函数，更好地支持中文备注。
以下是修改后的完整代码，你可以直接替换原文件：
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

// 新增：Clash 代理配置的类型定义，避免使用 any
interface ClashProxy {
  name: string;
  type: string;
  server: string;
  port: number | string;
  uuid?: string;
  password?: string;
  cipher?: string;
  udp?: boolean;
  tls?: boolean;
  sni?: string;
  network?: string;
  'client-fingerprint'?: string;
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
  plugin?: string;
  'plugin-opts'?: any;
  [key: string]: any; // 允许其他字段
}

/**
 * 强大的订阅解析器 (Refactored)
 * 支持多种格式：Base64、纯文本、YAML、Clash配置等
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
      'tuic', 'anytls', 'socks5'
    ];

    this._base64Regex = /^[A-Za-z0-9+\/=]+$/;
    this._whitespaceRegex = /\s/g;
    this._newlineRegex = /\r?\n/;
    this._nodeRegex = null;
    this._protocolRegex = /^(.*?):\/\//;
  }

  /**
   * 安全解码 Base64 字符串 (支持 UTF-8)
   */
  decodeBase64(str: string) {
    try {
      // 优先尝试 Node.js Buffer (如果环境支持)
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(str, 'base64').toString('utf8');
      }
      // 浏览器环境兼容
      const binaryString = atob(str);
      const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      console.warn('Base64 decoding failed, trying permissive mode:', e);
      try {
          return atob(str);
      } catch (e2) {
          return str; // 最后防线：返回原字符串
      }
    }
  }

  /**
   * 安全编码 Base64 (支持 UTF-8 中文)
   */
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

  /**
   * 解析订阅内容
   */
  parse(content: string, subscriptionName = ''): Node[] {
    if (!content || typeof content !== 'string') {
      return [];
    }

    let methods: (() => Node[])[] = [];

    // 优化：Magic String 快速检测，提升性能
    const trimmedStart = content.trimStart();
    
    // 1. 如果包含 proxies: 或 nodes:，极高概率是 YAML
    if (content.includes('proxies:') || content.includes('nodes:')) {
      methods.push(() => this.parseYAML(content, subscriptionName));
      methods.push(() => this.parseClashConfig(content, subscriptionName));
    }
    
    // 2. Base64 检测 (如果不是明显的YAML)
    const cleanedContent = content.replace(this._whitespaceRegex, '');
    if (this._base64Regex.test(cleanedContent) && cleanedContent.length > 20) {
      // 如果看起来像Base64，把它放在YAML之前或之后取决于具体情况
      // 这里策略是：如果不像YAML，优先Base64
      if (methods.length === 0) {
          methods.push(() => this.parseBase64(content, subscriptionName));
      } else {
          // 如果也可能是YAML，Base64排后面
          methods.push(() => this.parseBase64(content, subscriptionName));
      }
    }

    // 3. 兜底尝试纯文本
    methods.push(() => this.parsePlainText(content, subscriptionName));

    for (const method of methods) {
      try {
        const result = method();
        if (result && result.length > 0) {
          console.log(`解析成功，找到 ${result.length} 个节点`);
          return result;
        }
      } catch (error) {
        continue;
      }
    }

    return [];
  }

  parseBase64(content: string, subscriptionName: string): Node[] {
    const cleanedContent = content.replace(this._whitespaceRegex, '');
    if (!this._base64Regex.test(cleanedContent) || cleanedContent.length < 20) {
      throw new Error('不是有效的Base64编码');
    }

    try {
      const decodedContent = this.decodeBase64(cleanedContent);
      const decodedLines = decodedContent.split(this._newlineRegex).filter(line => line.trim() !== '');

      if (!decodedLines.some(line => this.isNodeUrl(line))) {
        throw new Error('Base64解码后未找到有效的节点链接');
      }

      return this.parseNodeLines(decodedLines, subscriptionName);
    } catch (error: any) {
      throw new Error(`Base64解码失败: ${error.message}`);
    }
  }

  parseYAML(content: string, subscriptionName: string): Node[] {
    try {
      const parsed: any = yaml.load(content);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('无效的YAML格式');
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
    try {
      const parsed: any = yaml.load(content);
      if (!parsed || !parsed.proxies || !Array.isArray(parsed.proxies)) {
        throw new Error('不是有效的Clash配置');
      }
      return this.parseClashProxies(parsed.proxies, subscriptionName);
    } catch (error: any) {
      throw new Error(`Clash配置解析失败: ${error.message}`);
    }
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
            name: proxy.name || '未命名节点',
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
        continue;
      }
    }
    return nodes;
  }

  convertClashProxyToUrl(proxy: ClashProxy) { // 使用新定义的接口
    const type = proxy.type?.toLowerCase();
    const server = proxy.server;
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
      ['socks5', () => this.buildSocks5Url(proxy)]
    ]);

    const handler = proxyTypeHandlers.get(type);
    return handler ? handler() : null;
  }

  /**
   * 构建VMess URL (修复 Base64 编码问题)
   */
  buildVmessUrl(proxy: ClashProxy) {
    const config = {
      v: '2',
      ps: proxy.name || 'VMess节点',
      add: proxy.server,
      port: proxy.port,
      id: proxy.uuid,
      aid: proxy.alterId || 0,
      net: proxy.network || 'tcp',
      type: proxy.type || 'none',
      host: proxy['ws-opts']?.headers?.Host || proxy.host || '',
      path: proxy['ws-opts']?.path || proxy.path || '',
      tls: proxy.tls ? 'tls' : 'none'
    };
    
    // 使用安全的 Base64 编码
    const jsonStr = JSON.stringify(config);
    const base64 = this.encodeBase64(jsonStr);
    return `vmess://${base64}`;
  }

  /**
   * 构建VLESS URL (大幅增强，支持 Reality)
   */
  buildVlessUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    
    // 1. 基础参数
    params.set('security', proxy.tls ? 'tls' : 'none');
    
    // 2. 传输层 (Transport)
    const network = proxy.network || 'tcp';
    params.set('type', network);

    if (network === 'ws') {
      if (proxy['ws-opts']?.path) params.set('path', proxy['ws-opts'].path);
      if (proxy['ws-opts']?.headers?.Host) params.set('host', proxy['ws-opts'].headers.Host);
    } else if (network === 'grpc') {
      if (proxy['grpc-opts']?.['grpc-service-name']) {
        params.set('serviceName', proxy['grpc-opts']['grpc-service-name']);
      }
    }

    // 3. Reality & TLS 特殊处理
    // 检查是否启用了 Reality (通常 Clash 配置里会有 reality-opts 或者 client-fingerprint)
    if (proxy['reality-opts'] || (proxy['client-fingerprint'] && proxy.tls)) {
       params.set('security', 'reality');
       if (proxy['reality-opts']?.['public-key']) params.set('pbk', proxy['reality-opts']['public-key']);
       if (proxy['reality-opts']?.['short-id']) params.set('sid', proxy['reality-opts']['short-id']);
       // Flow (Vision)
       if (proxy.flow) params.set('flow', proxy.flow);
    }
    
    // 指纹
    if (proxy['client-fingerprint']) {
        params.set('fp', proxy['client-fingerprint']);
    }

    // SNI
    if (proxy.sni || proxy.servername) {
      params.set('sni', proxy.sni || proxy.servername);
    }

    // 构建链接
    const userInfo = proxy.uuid;
    const address = `${proxy.server}:${proxy.port}`;
    const query = params.toString();
    const hash = encodeURIComponent(proxy.name || 'VLESS节点');

    return `vless://${userInfo}@${address}?${query}#${hash}`;
  }

  /**
   * 构建Trojan URL (标准化)
   */
  buildTrojanUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.network === 'ws') params.set('type', 'ws');
    if (proxy['ws-opts']?.path) params.set('path', proxy['ws-opts'].path);
    if (proxy['ws-opts']?.headers?.Host) params.set('host', proxy['ws-opts'].headers.Host);

    const userInfo = proxy.password;
    const address = `${proxy.server}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || 'Trojan节点');

    return `trojan://${userInfo}@${address}?${params.toString()}#${hash}`;
  }

  /**
   * 构建Shadowsocks URL
   */
  buildShadowsocksUrl(proxy: ClashProxy) {
    const method = proxy.cipher;
    const password = proxy.password;
    const auth = `${method}:${password}`;
    // 使用安全编码
    const base64 = this.encodeBase64(auth);
    const hash = encodeURIComponent(proxy.name || 'SS节点');
    
    // 标准 SS 格式：ss://base64(method:password)@server:port#name
    return `ss://${base64}@${proxy.server}:${proxy.port}#${hash}`;
  }

  /**
   * 构建ShadowsocksR URL
   */
  buildShadowsocksRUrl(proxy: ClashProxy) {
    const configStr = [
      proxy.server,
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

    const urlBase64 = this.encodeBase64(configStr);
    return `ssr://${urlBase64}/?${query.toString()}`;
  }

  /**
   * 构建Hysteria/Hy2 URL
   */
  buildHysteriaUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    
    // 通用参数映射
    if (proxy.protocol) params.set('protocol', proxy.protocol);
    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.auth || proxy.password) params.set('auth', proxy.auth || proxy.password);
    if (proxy.alpn) {
        const alpn = Array.isArray(proxy.alpn) ? proxy.alpn.join(',') : proxy.alpn;
        params.set('alpn', alpn);
    }
    if (proxy.up) params.set('up', proxy.up);
    if (proxy.down) params.set('down', proxy.down);
    if (proxy['skip-cert-verify']) params.set('insecure', '1');

    const address = `${proxy.server}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || 'Hysteria节点');
    
    // 区分 Hysteria 1 和 2 的协议头
    const scheme = (proxy.type === 'hysteria2') ? 'hysteria2' : 'hysteria';
    
    return `${scheme}://${address}?${params.toString()}#${hash}`;
  }

  buildTUICUrl(proxy: ClashProxy) {
    const params = new URLSearchParams();
    if (proxy.sni) params.set('sni', proxy.sni);
    if (proxy.alpn) params.set('alpn', Array.isArray(proxy.alpn) ? proxy.alpn.join(',') : proxy.alpn);
    if (proxy['skip-cert-verify']) params.set('insecure', '1');
    if (proxy.congestion_controller) params.set('congestion_controller', proxy.congestion_controller);

    const userInfo = `${proxy.uuid}:${proxy.password}`;
    const address = `${proxy.server}:${proxy.port}`;
    const hash = encodeURIComponent(proxy.name || 'TUIC节点');

    return `tuic://${userInfo}@${address}?${params.toString()}#${hash}`;
  }

  buildSocks5Url(proxy: ClashProxy) {
    let auth = '';
    if (proxy.username && proxy.password) {
      auth = `${proxy.username}:${proxy.password}@`;
    }
    const hash = encodeURIComponent(proxy.name || 'Socks5节点');
    return `socks5://${auth}${proxy.server}:${proxy.port}#${hash}`;
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
    const hashIndex = line.lastIndexOf('#'); // 修复：使用 lastIndexOf 避免参数中包含 #
    if (hashIndex !== -1) {
      name = decodeURIComponent(line.substring(hashIndex + 1) || '');
    }

    if (!name) {
      name = this.extractNodeNameFromUrl(line);
    }

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
      const protocol = url.match(this._protocolRegex)?.[1] || '';
      
      // 简单处理，复杂的解码交给具体客户端，这里只做兜底
      if (protocol === 'vmess') {
          try {
             const b64 = url.slice(8);
             const json = JSON.parse(this.decodeBase64(b64));
             return json.ps || json.add;
          } catch(e) {}
      }
      
      const hashIndex = url.lastIndexOf('#');
      if (hashIndex > -1) return decodeURIComponent(url.slice(hashIndex + 1));
      
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return '未命名节点';
    }
  }

  isNodeUrl(line: string) {
    if (!this._nodeRegex) {
      this._nodeRegex = new RegExp(`^(${this.supportedProtocols.join('|')}):\/\/`);
    }
    return this._nodeRegex.test(line.trim());
  }

  getSupportedProtocols() {
    return [...this.supportedProtocols];
  }

  // processNodes 保持不变...
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
          } else {
            nameRegexParts.push(content);
          }
        });
        const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;

        processed = processed.filter(node => {
          if (protocolsToKeep.has(node.protocol)) return true;
          if (nameRegex && nameRegex.test(node.name)) return true;
          return false;
        });
      } else {
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
          if (protocolsToExclude.has(node.protocol)) return false;
          if (nameRegex && nameRegex.test(node.name)) return false;
          return true;
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

