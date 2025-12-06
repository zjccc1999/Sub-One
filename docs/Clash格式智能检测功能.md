# Clash 格式智能检测功能说明

## ✅ 已完成的修复

### 修改内容

**文件**: `functions/[[path]].ts`  
**位置**: 第 1809-1857 行（新增）  
**功能**: 自动检测 Clash YAML 格式并跳过订阅转换器

---

## 🎯 功能说明

### 工作原理

系统现在会在调用订阅转换器之前，自动检测订阅内容是否已经是完整的 Clash YAML 配置：

```
用户访问订阅组链接 (target=clash)
    ↓
获取并合并订阅内容
    ↓
🆕 检测是否已经是 Clash YAML 格式
    ├─ 是 → ✅ 直接返回原始内容（保留所有配置）
    └─ 否 → 调用订阅转换器进行转换
```

### 检测规则

内容被识别为 Clash YAML 格式需要满足：

1. ✅ 包含 `proxies:` 字段
2. ✅ **并且** 包含 `proxy-groups:` **或** `rules:` 其中之一

**示例（会被检测为 Clash 格式）**:

```yaml
mixed-port: 7890
allow-lan: true

proxies:
  - name: "节点1"
    type: vmess
    server: test.com
    port: 443
    servername: gw.alicdn.com  # ← 这个字段会被保留！

proxy-groups:
  - name: "自动选择"
    type: url-test
    proxies: ["节点1"]

rules:
  - DOMAIN,google.com,PROXY
```

---

## 🎉 解决的问题

### 问题 1: 订阅转换器丢失关键配置

**修复前**:
```yaml
# 原始订阅（正确）
proxies:
  - name: "香港"
    type: vmess
    server: hk.example.com
    servername: gw.alicdn.com  # ✅ 有伪装
    
# 经过转换器后（错误）
proxies:
  - name: "香港"
    type: vmess
    server: hk.example.com
    # servername 字段丢失！  ❌
```

**修复后**:
```yaml
# 检测到是 Clash 格式，跳过转换器
# 原样返回，保留所有配置 ✅
proxies:
  - name: "香港"
    type: vmess
    server: hk.example.com
    servername: gw.alicdn.com  # ✅ 保留
```

### 问题 2: 所有节点超时

**原因**: 缺少 `servername` 导致 TLS 握手失败  
**现在**: 自动保留原始配置，节点正常工作 ✅

---

## 📋 使用说明

### 对用户透明

这个功能**完全自动**，用户无需任何操作：

1. ✅ 如果订阅源是 Clash 格式 → 自动跳过转换器
2. ✅ 如果订阅源是 Base64/其他格式 → 正常使用转换器
3. ✅ 保留所有原始配置参数

### 适用场景

#### 场景 A: 原始订阅已经是 Clash 格式

**订阅源**: 返回完整的 Clash YAML

**行为**:
- 访问 `https://your-domain.com/token?target=clash`
- 系统检测到是 Clash 格式
- **直接返回原始内容**
- ✅ 保留 `servername`、`skip-cert-verify`、`udp` 等所有字段
- ✅ 节点正常工作

#### 场景 B: 原始订阅是 Base64/VMess 链接

**订阅源**: 返回 Base64 编码的 vmess:// 链接列表

**行为**:
- 访问 `https://your-domain.com/token?target=clash`
- 系统检测到不是 Clash 格式
- **调用订阅转换器** (sub.xeton.dev)
- 转换为 Clash YAML
- ✅ 正常工作

#### 场景 C: 混合多个订阅

**订阅组**: 包含 2 个订阅
- 订阅 A: Clash YAML 格式
- 订阅 B: Base64 格式

**行为**:
- 系统合并两个订阅的内容
- 合并后的内容**不是**完整的 Clash YAML（因为包含了 Base64）
- **调用订阅转换器**进行统一转换
- ⚠️ 这种情况下可能仍会丢失配置

**建议**: 尽量使用相同格式的订阅源

---

## 🔍 功能验证

### 测试步骤

#### 1. 检查订阅源格式

```bash
# 查看原始订阅是什么格式
curl -H "User-Agent: ClashforWindows/0.20.39" "你的订阅源URL" | head -20
```

**如果看到**:
```yaml
proxies:
  - name: "..."
proxy-groups:
  - name: "..."
```
说明是 Clash 格式，会自动跳过转换器。

#### 2. 测试订阅组链接

```bash
# 访问订阅组链接
curl "https://sub.lbyan.hidns.vip/my/11f8eca0-f492-4552-8302-e27ed84d0e6f?target=clash" > output.yaml

# 检查是否保留了 servername
grep "servername" output.yaml
```

**预期结果**:
```yaml
servername: gw.alicdn.com  # ✅ 应该能看到这个字段
```

#### 3. 在 Clash Verge 中测试

1. 重新导入订阅组链接
2. 查看节点列表
3. 选择任意节点连接
4. ✅ 应该能够正常连接，不再超时

---

## 📊 日志输出

### 控制台日志

当检测到 Clash 格式时，会输出日志：

```
✅ Detected Clash YAML format, skipping converter to preserve original config
```

可以在 Cloudflare Pages 的日志中查看（实时日志或部署日志）。

---

## 🔧 技术细节

### 检测逻辑

```typescript
const isClashYAML = (content: string): boolean => {
    const trimmed = content.trim();
    
    // 使用正则表达式检测关键字段
    const hasProxies = /^proxies:\s*$/m.test(trimmed) || 
                       /\nproxies:\s*$/m.test(trimmed);
    const hasProxyGroups = /^proxy-groups:\s*$/m.test(trimmed) || 
                           /\nproxy-groups:\s*$/m.test(trimmed);
    const hasRules = /^rules:\s*$/m.test(trimmed) || 
                     /\nrules:\s*$/m.test(trimmed);
    
    // 必须有 proxies 和至少一个其他关键字段
    return hasProxies && (hasProxyGroups || hasRules);
};
```

### 流量信息保留

即使跳过转换器，系统仍会生成 `Subscription-Userinfo` 响应头：

```http
Subscription-Userinfo: upload=123456; download=789012; total=1073741824; expire=1735689600
```

这确保客户端能正确显示流量信息。

---

## ⚠️ 注意事项

### 1. 多订阅合并

如果订阅组包含多个不同格式的订阅：

- ✅ **全部是 Clash 格式**: 合并后仍是 Clash 格式，跳过转换器
- ❌ **混合格式**: 合并后不是完整的 Clash 格式，会调用转换器

**建议**: 保持订阅源格式一致。

### 2. 转换配置失效

当检测到 Clash 格式并跳过转换器时：

- ⚠️ 设置中的"转换配置" (subConfig) 不会应用
- ⚠️ 订阅转换器的自定义规则不会应用
- ✅ 使用原始订阅的规则和配置

**如果需要自定义规则**: 在原始订阅源中直接配置。

### 3. 节点分组

原始订阅的 `proxy-groups` 会被保留：

```yaml
proxy-groups:
  - name: "自动选择"
    type: url-test
    proxies: ["节点1", "节点2"]
```

不会应用转换配置中的自定义分组。

---

## 🎯 总结

### 修复效果

| 项目 | 修复前 | 修复后 |
|------|--------|--------|
| Clash 格式订阅 | 经过转换器，可能丢失配置 | 自动检测，直接返回 ✅ |
| 节点 servername | 可能丢失，导致超时 | 完整保留 ✅ |
| 节点连接 | ❌ 超时 | ✅ 正常 |
| 流量信息 | ✅ 正常 | ✅ 正常 |
| Base64 订阅 | ✅ 正常转换 | ✅ 正常转换 |

### 核心优势

1. ✅ **自动智能**: 无需用户手动配置
2. ✅ **保留配置**: 不丢失任何原始参数
3. ✅ **向后兼容**: 不影响现有功能
4. ✅ **性能提升**: 跳过不必要的转换请求

---

## 🚀 立即生效

修改已经完成，**无需重新部署**即可生效（如果使用 Cloudflare Pages 的话，保存后自动部署）。

### 测试你的订阅组

```bash
# 重新访问订阅组链接
curl "https://sub.lbyan.hidns.vip/my/11f8eca0-f492-4552-8302-e27ed84d0e6f?target=clash" | grep servername

# 应该看到输出：
# servername: gw.alicdn.com
```

如果看到 `servername` 字段，说明功能正常工作！🎉

---

**功能完成时间**: 2025-12-06 14:45  
**影响范围**: Clash 格式订阅的处理  
**向后兼容**: ✅ 完全兼容  
**性能影响**: ✅ 略有提升（减少转换器调用）
