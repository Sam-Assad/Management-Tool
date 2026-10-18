import { parseSocketBindings, urlHost, readReadiness, notReadyReason } from '../server/src/scan/wildfly.ts';

const sample = `Handler FILE is not defined
{
    "outcome" => "success",
    "result" => [
        {
            "address" => [
                ("socket-binding-group" => "standard-sockets"),
                ("socket-binding" => "ajp")
            ],
            "outcome" => "success",
            "result" => {
                "bound" => false,
                "bound-address" => undefined,
                "bound-port" => undefined,
                "client-mappings" => undefined,
                "fixed-port" => false,
                "interface" => undefined,
                "port" => expression "\${jboss.ajp.port:8009}"
            }
        },
        {
            "address" => [
                ("socket-binding-group" => "standard-sockets"),
                ("socket-binding" => "http")
            ],
            "outcome" => "success",
            "result" => {
                "bound" => true,
                "bound-address" => "10.20.30.40",
                "bound-port" => 8080,
                "client-mappings" => undefined,
                "port" => expression "\${jboss.http.port:8080}"
            }
        },
        {
            "address" => [
                ("socket-binding-group" => "standard-sockets"),
                ("socket-binding" => "https")
            ],
            "outcome" => "success",
            "result" => {
                "bound" => true,
                "bound-address" => "0.0.0.0",
                "bound-port" => 8443
            }
        },
        {
            "address" => [
                ("socket-binding-group" => "standard-sockets"),
                ("socket-binding" => "management-http")
            ],
            "outcome" => "success",
            "result" => {
                "bound" => true,
                "bound-address" => "fe80:0:0:0:0:0:0:1",
                "bound-port" => 9990,
                "interface" => "management"
            }
        }
    ]
}`;

let fails = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : `  (wanted ${JSON.stringify(want)})`}`);
};

const b = parseSocketBindings(sample);
check('unbound ajp skipped', b.has('ajp'), false);
check('http', b.get('http'), { address: '10.20.30.40', port: 8080 });
check('https', b.get('https'), { address: '0.0.0.0', port: 8443 });
check('management-http', b.get('management-http'), { address: 'fe80:0:0:0:0:0:0:1', port: 9990 });
check('urlHost ipv4', urlHost('10.20.30.40'), '10.20.30.40');
check('urlHost any-v4', urlHost('0.0.0.0'), '127.0.0.1');
check('urlHost any-v6', urlHost('0:0:0:0:0:0:0:0'), '127.0.0.1');
check('urlHost ipv6', urlHost('fe80:0:0:0:0:0:0:1'), '[fe80:0:0:0:0:0:0:1]');
check('urlHost hostname', urlHost('mgt-x.example.local'), 'mgt-x.example.local');
const mp = readReadiness('{"status":"DOWN","checks":[{"name":"boot-errors","status":"UP"},{"name":"deployments-status","status":"DOWN","data":{"loyalty.war":"FAILED"}}]}');
check('microprofile down', mp.down, ['deployments-status']);
check('microprofile failed deployment', mp.failedDeployments, ['loyalty.war']);
check('garbage', readReadiness('<html>401</html>').down, []);

// the real WildFly 26 reply captured from loyalty_1 (trimmed to one failed part)
const bootErrors = JSON.stringify([
  {
    'failed-operation': { operation: 'add', address: [{ deployment: 'loyalty-management-0.0.4-SNAPSHOT.ear' }] },
    'failed-services': {
      'jboss.deployment.subunit."loyalty-management-0.0.4-SNAPSHOT.ear"."http-interface-2.2.0-SNAPSHOT.war".undertow-deployment':
        "java.lang.RuntimeException: BeanCreationException: Error creating bean 'entityManagerFactory'\n    Caused by: org.hibernate.service.spi.ServiceException: Unable to create requested service\n    Caused by: org.hibernate.HibernateException: Access to DialectResolutionInfo cannot be null when 'hibernate.dialect' not set",
      'jboss.deployment.subunit."loyalty-management-0.0.4-SNAPSHOT.ear"."message-interface-2.1.0-SNAPSHOT.war".undertow-deployment':
        "java.lang.RuntimeException: x\n    Caused by: org.hibernate.HibernateException: Access to DialectResolutionInfo cannot be null when 'hibernate.dialect' not set",
    },
  },
]);
const wf = readReadiness(
  JSON.stringify([
    { name: 'server-state', outcome: true, data: [{ value: 'running' }] },
    { name: 'boot-errors', outcome: false, data: [{ 'boot-errors': bootErrors }] },
    { name: 'deployments-status', outcome: false, data: [{ 'loyalty-management-0.0.4-SNAPSHOT.ear': 'FAILED' }] },
    { outcome: false },
  ]),
);
check('wf26 down', wf.down, ['boot-errors', 'deployments-status']);
check('wf26 failed deployment', wf.failedDeployments, ['loyalty-management-0.0.4-SNAPSHOT.ear']);
check('wf26 failed parts', wf.failedParts, ['http-interface-2.2.0-SNAPSHOT.war', 'message-interface-2.1.0-SNAPSHOT.war']);
check('wf26 cause', wf.causes, ["org.hibernate.HibernateException: Access to DialectResolutionInfo cannot be null when 'hibernate.dialect' not set"]);
console.log('\nreason: ' + notReadyReason(wf));
check('wf26 ok deployment not flagged', readReadiness('[{"name":"deployments-status","outcome":false,"data":[{"a.war":"OK","b.war":"STOPPED"}]}]').failedDeployments, ['b.war']);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
