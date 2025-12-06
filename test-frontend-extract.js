/**
 * 前端 extractNodeNameFromUrl 方法测试
 * 
 * 使用方法：
 * 1. 打开浏览器，访问你的应用
 * 2. 按 F12 打开开发者控制台
 * 3. 复制并粘贴此脚本到控制台执行
 */

(function () {
    console.log('%c🧪 开始测试前端 extractNodeNameFromUrl 方法', 'color: blue; font-size: 16px; font-weight: bold');
    console.log('='.repeat(80));

    // 测试用例
    const testCases = [
        {
            name: 'VMess with name in config',
            url: 'vmess://eyJwcyI6IkhvbmcgS29uZy0wMSIsImFkZCI6ImhrLnRlc3QuY29tIiwicG9ydCI6NDQzLCJpZCI6InV1aWQtMTIzIn0=',
            expected: 'Hong Kong-01'
        },
        {
            name: 'VMess with hash name (priority test)',
            url: 'vmess://eyJwcyI6IkhLLTAxIiwiYWRkIjoiaGsudGVzdC5jb20ifQ==#Custom-Name',
            expected: 'Custom-Name'
        },
        {
            name: 'VLESS without hash',
            url: 'vless://uuid-123@sg.example.com:443?type=ws&path=/ws',
            expected: 'sg.example.com'
        },
        {
            name: 'VLESS with hash name',
            url: 'vless://uuid-123@sg.example.com:443?type=ws#Singapore-Fast',
            expected: 'Singapore-Fast'
        },
        {
            name: 'Trojan without hash',
            url: 'trojan://password123@jp.test.com:443?sni=jp.test.com',
            expected: 'jp.test.com'
        },
        {
            name: 'Trojan with hash name',
            url: 'trojan://password123@jp.test.com:443#Japan-Tokyo',
            expected: 'Japan-Tokyo'
        },
        {
            name: 'Shadowsocks with @ in URL',
            url: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@us.example.com:8388',
            expected: 'us.example.com'
        },
        {
            name: 'Shadowsocks with hash name',
            url: 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@us.example.com:8388#US-Node',
            expected: 'US-Node'
        },
        {
            name: 'Hysteria2 without hash',
            url: 'hysteria2://hy2.example.com:443?auth=secret',
            expected: 'hy2.example.com'
        },
        {
            name: 'Hysteria2 with hash',
            url: 'hysteria2://hy2.example.com:443?auth=secret#HK-Hysteria2',
            expected: 'HK-Hysteria2'
        },
        {
            name: 'Hysteria (hy) shorthand',
            url: 'hy://hy.server.com:36712',
            expected: 'hy.server.com'
        },
        {
            name: 'TUIC without hash',
            url: 'tuic://uuid:password@tuic.test.com:443?sni=tuic.test.com',
            expected: 'tuic.test.com'
        },
        {
            name: 'TUIC with hash',
            url: 'tuic://uuid:password@tuic.test.com:443#TUIC-Fast',
            expected: 'TUIC-Fast'
        },
        {
            name: 'Socks5 without auth',
            url: 'socks5://socks.proxy.com:1080',
            expected: 'socks.proxy.com'
        },
        {
            name: 'Socks5 with auth',
            url: 'socks5://user:pass@socks.proxy.com:1080',
            expected: 'socks.proxy.com'
        },
        {
            name: 'Socks5 with hash',
            url: 'socks5://user:pass@socks.proxy.com:1080#My-Socks5',
            expected: 'My-Socks5'
        }
    ];

    // 尝试导入 subscriptionParser
    let parser;
    try {
        // 尝试从全局作用域获取
        if (typeof window !== 'undefined' && window.subscriptionParser) {
            parser = window.subscriptionParser;
        } else {
            console.error('❌ 无法找到 subscriptionParser');
            console.log('📝 请确保：');
            console.log('  1. 应用已加载');
            console.log('  2. subscriptionParser 已导出到全局作用域');
            console.log('  3. 或者在 Vue 组件中运行此测试');
            return;
        }
    } catch (e) {
        console.error('❌ 导入 subscriptionParser 失败:', e);
        return;
    }

    let passed = 0;
    let failed = 0;
    const failures = [];

    testCases.forEach((test, index) => {
        try {
            const result = parser.extractNodeNameFromUrl(test.url);
            const success = result === test.expected;

            if (success) {
                console.log(`%c✅ [${index + 1}/${testCases.length}] ${test.name}`, 'color: green');
                passed++;
            } else {
                console.log(`%c❌ [${index + 1}/${testCases.length}] ${test.name}`, 'color: red');
                console.log(`   链接: ${test.url.substring(0, 60)}...`);
                console.log(`   %c期望: "${test.expected}"`, 'color: blue');
                console.log(`   %c实际: "${result}"`, 'color: orange');
                failed++;
                failures.push({ test, result });
            }
        } catch (e) {
            console.log(`%c❌ [${index + 1}/${testCases.length}] ${test.name} (异常)`, 'color: red');
            console.error('   错误:', e);
            failed++;
            failures.push({ test, result: `异常: ${e.message}` });
        }
    });

    console.log('='.repeat(80));
    console.log(`%c📊 测试结果: ${passed}/${testCases.length} 通过, ${failed} 失败`,
        failed === 0 ? 'color: green; font-size: 14px; font-weight: bold' : 'color: red; font-size: 14px; font-weight: bold');

    if (failed > 0) {
        console.log('\n%c❌ 失败的测试用例：', 'color: red; font-weight: bold');
        failures.forEach(({ test, result }) => {
            console.log(`  %c- ${test.name}`, 'color: orange');
            console.log(`    期望: "${test.expected}"`);
            console.log(`    实际: "${result}"`);
        });
    } else {
        console.log('\n%c🎉 所有测试通过！前端修复成功！', 'color: green; font-size: 16px; font-weight: bold');
    }

    // 返回结果对象
    return {
        total: testCases.length,
        passed,
        failed,
        failures
    };
})();
