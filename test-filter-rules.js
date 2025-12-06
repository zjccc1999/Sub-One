// 过滤规则集成测试
// 测试修复后过滤规则是否正确应用到所有协议


// 复制后端的 extractName 方法
function extractName(link) {
    try {
        const hashIndex = link.lastIndexOf('#');
        if (hashIndex !== -1 && hashIndex < link.length - 1) {
            const name = decodeURIComponent(link.substring(hashIndex + 1));
            if (name.trim()) return name.trim();
        }

        if (link.startsWith('vmess://')) {
            const base64Part = link.substring(8);
            const config = JSON.parse(Buffer.from(base64Part, 'base64').toString('utf-8'));
            return config.ps || config.add || 'VMess';
        }

        if (link.startsWith('vless://')) {
            const match = link.match(/vless:\/\/[^@]+@([^:?#]+)/);
            if (match) return match[1];
        }

        if (link.startsWith('trojan://')) {
            const match = link.match(/trojan:\/\/[^@]+@([^:?#]+)/);
            if (match) return match[1];
        }

        if (link.startsWith('ss://')) {
            const atMatch = link.match(/@([^:?#]+)/);
            if (atMatch) return atMatch[1];
        }

        if (link.match(/^(hysteria2?|hy2?):\/\//)) {
            const match = link.match(/^(?:hysteria2?|hy2?):\/\/([^:?#]+)/);
            if (match) return match[1];
        }

        if (link.startsWith('tuic://')) {
            const match = link.match(/tuic:\/\/[^@]+@([^:?#]+)/);
            if (match) return match[1];
        }

        if (link.startsWith('socks5://')) {
            const match = link.match(/socks5:\/\/(?:[^@]+@)?([^:?#]+)/);
            if (match) return match[1];
        }

        const protocolMatch = link.match(/^([^:]+):/);
        if (protocolMatch) {
            return protocolMatch[1].toUpperCase() + ' 节点';
        }
    } catch (e) { }
    return '未知节点';
}

// 复制后端的 processNodes 过滤逻辑（简化版）
function applyFilter(nodes, excludePattern) {
    if (!excludePattern || !excludePattern.trim()) {
        return nodes;
    }

    const rules = excludePattern.trim().split('\n').map(r => r.trim()).filter(Boolean);
    const keepRules = rules.filter(r => r.toLowerCase().startsWith('keep:'));

    if (keepRules.length > 0) {
        // 白名单模式
        const nameRegexParts = [];
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

        return nodes.filter(link => {
            const proto = link.split(':')[0].toLowerCase();
            if (protocolsToKeep.has(proto)) return true;
            if (nameRegex) {
                const name = extractName(link);
                if (nameRegex.test(name)) return true;
            }
            return false;
        });
    } else {
        // 黑名单模式
        const protocolsToExclude = new Set();
        const nameRegexParts = [];

        rules.forEach(rule => {
            if (rule.toLowerCase().startsWith('proto:')) {
                rule.substring(6).split(',').forEach(p => protocolsToExclude.add(p.trim().toLowerCase()));
            } else {
                nameRegexParts.push(rule);
            }
        });

        const nameRegex = nameRegexParts.length ? new RegExp(nameRegexParts.join('|'), 'i') : null;

        return nodes.filter(link => {
            const proto = link.split(':')[0].toLowerCase();
            if (protocolsToExclude.has(proto)) return false;
            if (nameRegex) {
                const name = extractName(link);
                if (nameRegex.test(name)) return false;
            }
            return true;
        });
    }
}

// 测试场景
const testScenarios = [
    {
        name: '场景 1: 排除香港和日本节点',
        filter: '香港|日本|HK|JP',
        nodes: [
            'vmess://eyJwcyI6IuWMl+a4rzAxIiwiYWRkIjoiaGsudGVzdC5jb20ifQ==#香港-01',
            'vless://uuid@hk.example.com:443?type=ws',
            'trojan://pass@jp.test.com:443',
            'vless://uuid@sg.example.com:443#Singapore-01',
            'ss://base64@us.proxy.com:443#美国节点'
        ],
        expected: {
            filtered: [
                'vmess://eyJwcyI6IuWMl+a4rzAxIiwiYWRkIjoiaGsudGVzdC5jb20ifQ==#香港-01',
                'trojan://pass@jp.test.com:443'
            ],
            kept: [
                'vless://uuid@hk.example.com:443?type=ws',
                'vless://uuid@sg.example.com:443#Singapore-01',
                'ss://base64@us.proxy.com:443#美国节点'
            ]
        }
    },
    {
        name: '场景 2: 只保留新加坡节点（白名单）',
        filter: 'keep:Singapore|SG|新加坡|sg.example',
        nodes: [
            'vless://uuid@sg.example.com:443#Singapore-01',
            'vmess://base64#新加坡-快速',
            'trojan://pass@hk.test.com:443',
            'vless://uuid@singapore.proxy.net:443'
        ],
        expected: {
            filtered: [
                'trojan://pass@hk.test.com:443'
            ],
            kept: [
                'vless://uuid@sg.example.com:443#Singapore-01',
                'vmess://base64#新加坡-快速',
                'vless://uuid@singapore.proxy.net:443'
            ]
        }
    },
    {
        name: '场景 3: 排除特定协议',
        filter: 'proto:ss,ssr',
        nodes: [
            'vmess://base64#VMess-节点',
            'vless://uuid@vless.com:443',
            'ss://base64@ss.server.com:443',
            'trojan://pass@trojan.com:443',
            'ssr://base64'
        ],
        expected: {
            filtered: [
                'ss://base64@ss.server.com:443',
                'ssr://base64'
            ],
            kept: [
                'vmess://base64#VMess-节点',
                'vless://uuid@vless.com:443',
                'trojan://pass@trojan.com:443'
            ]
        }
    },
    {
        name: '场景 4: 混合规则 - 排除协议和名称',
        filter: 'proto:ss\n香港',
        nodes: [
            'vmess://base64#香港-VMess',
            'vless://uuid@sg.com:443#新加坡',
            'ss://base64@us.com:443#美国',
            'trojan://pass@hk.com:443'
        ],
        expected: {
            filtered: [
                'vmess://base64#香港-VMess',
                'ss://base64@us.com:443#美国'
            ],
            kept: [
                'vless://uuid@sg.com:443#新加坡',
                'trojan://pass@hk.com:443'
            ]
        }
    }
];

// 运行测试
console.log('🧪 开始测试过滤规则集成\n');
console.log('='.repeat(80));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

testScenarios.forEach((scenario, scenarioIndex) => {
    console.log(`\n📋 ${scenario.name}`);
    console.log(`   过滤规则: "${scenario.filter}"`);
    console.log(`   节点总数: ${scenario.nodes.length}`);

    const result = applyFilter(scenario.nodes, scenario.filter);
    const filtered = scenario.nodes.filter(n => !result.includes(n));

    // 验证结果
    let scenarioPassed = true;

    // 检查保留的节点
    scenario.expected.kept.forEach((expectedNode, i) => {
        totalTests++;
        if (result.includes(expectedNode)) {
            console.log(`   ✅ 应保留节点 ${i + 1}: ${extractName(expectedNode)}`);
            passedTests++;
        } else {
            console.log(`   ❌ 应保留但被过滤: ${extractName(expectedNode)}`);
            console.log(`      节点: ${expectedNode.substring(0, 60)}...`);
            scenarioPassed = false;
            failedTests++;
        }
    });

    // 检查过滤的节点
    scenario.expected.filtered.forEach((expectedNode, i) => {
        totalTests++;
        if (!result.includes(expectedNode)) {
            console.log(`   ✅ 应过滤节点 ${i + 1}: ${extractName(expectedNode)}`);
            passedTests++;
        } else {
            console.log(`   ❌ 应过滤但被保留: ${extractName(expectedNode)}`);
            console.log(`      节点: ${expectedNode.substring(0, 60)}...`);
            scenarioPassed = false;
            failedTests++;
        }
    });

    if (scenarioPassed) {
        console.log(`   ✅ 场景测试通过`);
    } else {
        console.log(`   ❌ 场景测试失败`);
    }
});

console.log('\n' + '='.repeat(80));
console.log(`\n📊 总测试结果: ${passedTests}/${totalTests} 通过, ${failedTests} 失败\n`);

if (failedTests === 0) {
    console.log('🎉 所有过滤规则测试通过！修复成功！');
    process.exit(0);
} else {
    console.log('❌ 部分过滤规则测试失败，请检查！');
    process.exit(1);
}
