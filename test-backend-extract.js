// 后端 extractName 方法测试脚本
// 测试修复后的节点名称提取功能

// 模拟后端的 extractName 方法（从 functions/[[path]].ts 复制）
function extractName(link) {
    try {
        // 1. 优先从 # 后提取名称
        const hashIndex = link.lastIndexOf('#');
        if (hashIndex !== -1 && hashIndex < link.length - 1) {
            const name = decodeURIComponent(link.substring(hashIndex + 1));
            if (name.trim()) return name.trim();
        }

        // 2. 根据协议特殊处理
        // VMess: 从 JSON 配置中提取
        if (link.startsWith('vmess://')) {
            const base64Part = link.substring(8);
            const config = JSON.parse(
                Buffer.from(base64Part, 'base64').toString('utf-8')
            );
            return config.ps || config.add || 'VMess';
        }

        // VLESS: vless://uuid@server:port
        if (link.startsWith('vless://')) {
            const match = link.match(/vless:\/\/[^@]+@([^:?#]+)/);
            if (match) return match[1];
        }

        // Trojan: trojan://password@server:port
        if (link.startsWith('trojan://')) {
            const match = link.match(/trojan:\/\/[^@]+@([^:?#]+)/);
            if (match) return match[1];
        }

        // Shadowsocks: ss://base64(method:password)@server:port
        if (link.startsWith('ss://')) {
            try {
                // 尝试提取 @server 部分
                const atMatch = link.match(/@([^:?#]+)/);
                if (atMatch) return atMatch[1];

                // 如果没有 @，可能是 SIP002 格式，需要解码
                const base64Match = link.match(/ss:\/\/([^#]+)/);
                if (base64Match) {
                    const decoded = Buffer.from(base64Match[1], 'base64').toString();
                    const serverMatch = decoded.match(/@([^:]+)/);
                    if (serverMatch) return serverMatch[1];
                }
            } catch (e) {
                // Base64 解码失败，降级到默认
            }
        }

        // Hysteria/Hysteria2: hysteria(2)://server:port 或 hy(2)://server:port
        if (link.match(/^(hysteria2?|hy2?):\/\//)) {
            const match = link.match(/^(?:hysteria2?|hy2?):\/\/([^:?#]+)/);
            if (match) return match[1];
        }

        // TUIC: tuic://uuid:password@server:port
        if (link.startsWith('tuic://')) {
            const match = link.match(/tuic:\/\/[^@]+@([^:?#]+)/);
            if (match) return match[1];
        }

        // Socks5: socks5://[user:pass@]server:port
        if (link.startsWith('socks5://')) {
            const match = link.match(/socks5:\/\/(?:[^@]+@)?([^:?#]+)/);
            if (match) return match[1];
        }

        // 3. 默认：返回协议名作为标识
        const protocolMatch = link.match(/^([^:]+):/);
        if (protocolMatch) {
            return protocolMatch[1].toUpperCase() + ' 节点';
        }

    } catch (e) {
        console.warn('extractName failed for link:', link, e);
    }

    return '未知节点';
}

// 测试用例
const testCases = [
    {
        name: 'VMess with name in config',
        link: 'vmess://eyJwcyI6IkhvbmcgS29uZy0wMSIsImFkZCI6ImhrLnRlc3QuY29tIiwicG9ydCI6NDQzLCJpZCI6InV1aWQtMTIzIn0=',
        expected: 'Hong Kong-01'
    },
    {
        name: 'VMess with hash name (priority test)',
        link: 'vmess://eyJwcyI6IkhLLTAxIiwiYWRkIjoiaGsudGVzdC5jb20ifQ==#Custom-Name',
        expected: 'Custom-Name'
    },
    {
        name: 'VLESS without hash',
        link: 'vless://uuid-123@sg.example.com:443?type=ws&path=/ws',
        expected: 'sg.example.com'
    },
    {
        name: 'VLESS with hash name',
        link: 'vless://uuid-123@sg.example.com:443?type=ws#Singapore-Fast',
        expected: 'Singapore-Fast'
    },
    {
        name: 'Trojan without hash',
        link: 'trojan://password123@jp.test.com:443?sni=jp.test.com',
        expected: 'jp.test.com'
    },
    {
        name: 'Trojan with hash name',
        link: 'trojan://password123@jp.test.com:443#Japan-Tokyo',
        expected: 'Japan-Tokyo'
    },
    {
        name: 'Shadowsocks SIP002 format',
        link: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmRAc3MudGVzdC5jb206NDQz',
        expected: 'ss.test.com'
    },
    {
        name: 'Shadowsocks with @ in URL',
        link: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@us.example.com:8388',
        expected: 'us.example.com'
    },
    {
        name: 'Shadowsocks with hash name',
        link: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@us.example.com:8388#US-Node',
        expected: 'US-Node'
    },
    {
        name: 'Hysteria2 without hash',
        link: 'hysteria2://hy2.example.com:443?auth=secret',
        expected: 'hy2.example.com'
    },
    {
        name: 'Hysteria2 with hash',
        link: 'hysteria2://hy2.example.com:443?auth=secret#HK-Hysteria2',
        expected: 'HK-Hysteria2'
    },
    {
        name: 'Hysteria (hy) shorthand',
        link: 'hy://hy.server.com:36712',
        expected: 'hy.server.com'
    },
    {
        name: 'TUIC without hash',
        link: 'tuic://uuid:password@tuic.test.com:443?sni=tuic.test.com',
        expected: 'tuic.test.com'
    },
    {
        name: 'TUIC with hash',
        link: 'tuic://uuid:password@tuic.test.com:443#TUIC-Fast',
        expected: 'TUIC-Fast'
    },
    {
        name: 'Socks5 without auth',
        link: 'socks5://socks.proxy.com:1080',
        expected: 'socks.proxy.com'
    },
    {
        name: 'Socks5 with auth',
        link: 'socks5://user:pass@socks.proxy.com:1080',
        expected: 'socks.proxy.com'
    },
    {
        name: 'Socks5 with hash',
        link: 'socks5://user:pass@socks.proxy.com:1080#My-Socks5',
        expected: 'My-Socks5'
    },
    {
        name: 'Unknown protocol',
        link: 'unknown://server.com:443',
        expected: 'UNKNOWN 节点'
    }
];

// 运行测试
console.log('🧪 开始测试后端 extractName 方法\n');
console.log('='.repeat(80));

let passed = 0;
let failed = 0;
const failures = [];

testCases.forEach((test, index) => {
    const result = extractName(test.link);
    const success = result === test.expected;

    if (success) {
        console.log(`✅ [${index + 1}/${testCases.length}] ${test.name}`);
        passed++;
    } else {
        console.log(`❌ [${index + 1}/${testCases.length}] ${test.name}`);
        console.log(`   链接: ${test.link.substring(0, 60)}...`);
        console.log(`   期望: "${test.expected}"`);
        console.log(`   实际: "${result}"`);
        failed++;
        failures.push({ test, result });
    }
});

console.log('='.repeat(80));
console.log(`\n📊 测试结果: ${passed}/${testCases.length} 通过, ${failed} 失败\n`);

if (failed > 0) {
    console.log('❌ 失败的测试用例：\n');
    failures.forEach(({ test, result }) => {
        console.log(`  - ${test.name}`);
        console.log(`    期望: "${test.expected}"`);
        console.log(`    实际: "${result}"`);
        console.log('');
    });
    process.exit(1);
} else {
    console.log('🎉 所有测试通过！修复成功！');
    process.exit(0);
}
