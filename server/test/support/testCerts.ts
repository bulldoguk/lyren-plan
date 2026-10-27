// Throwaway TLS certificates for the SMTP tests (design §14.2), made with openssl at test time in a
// temporary folder and never committed: a certificate authority, a server certificate for localhost and
// 127.0.0.1 signed by it, and one for another host (other.example) signed by it too. Without openssl on
// PATH there are none, and the TLS cases are skipped with that reason (CI has openssl).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestCerts {
  dir: string;
  /** The authority's certificate (PEM): what a client must trust. */
  ca: string;
  /** localhost and 127.0.0.1. */
  key: string;
  cert: string;
  /** other.example: a valid chain for the wrong host. */
  otherKey: string;
  otherCert: string;
}

/** Why there are no certificates (openssl is missing), or null when there is openssl. */
export function missingOpenssl(): string | null {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return null;
  } catch {
    return 'openssl is not on PATH, so no test certificates can be made';
  }
}

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

/** Certificates in a new folder under `parent` (default the system temp folder); remove `dir` when done. */
export function makeTestCerts(parent: string = os.tmpdir()): TestCerts {
  const dir = fs.mkdtempSync(path.join(parent, 'lyren-certs-'));
  // named_curve: LibreSSL (macOS's /usr/bin/openssl) otherwise writes the curve out as explicit
  // parameters, which Node's OpenSSL refuses.
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes'];
  openssl(dir, ['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Lyren Plan test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const leaf = (name: string, san: string) => {
    fs.writeFileSync(path.join(dir, `${name}.cnf`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`);
    openssl(dir, ['req', ...ec, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`]);
    // -sha256: LibreSSL signs with SHA-1 by default, which Node's OpenSSL refuses too.
    openssl(dir, ['x509', '-req', '-sha256', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.cnf`]);
  };
  leaf('localhost', 'DNS:localhost,IP:127.0.0.1');
  leaf('other', 'DNS:other.example');
  const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
  return {
    dir,
    ca: read('ca.pem'),
    key: read('localhost.key'),
    cert: read('localhost.pem'),
    otherKey: read('other.key'),
    otherCert: read('other.pem'),
  };
}
