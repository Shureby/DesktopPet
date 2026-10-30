//! Pet Post's identity and TLS: a self-signed certificate made once and kept, whose
//! fingerprint is how other devices know this one (as in LocalSend). Peers are trusted by
//! fingerprint, not by a certificate authority, so the verifiers below only check that the
//! other side holds the key of the certificate it shows (and, when we know it, that the
//! certificate is the one announced).

use std::path::Path;
use std::sync::{Arc, Mutex};

use desktoppet_core::post::fingerprint;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{CertificateError, DigitallySignedStruct, DistinguishedName, Error, SignatureScheme};

/// This device's certificate and key (DER), and its fingerprint.
#[derive(Clone)]
pub struct Identity {
    pub cert: Vec<u8>,
    pub key: Vec<u8>,
    pub fingerprint: String,
}

impl Identity {
    /// Reads the identity from `dir`, or makes one and saves it there. It must stay the
    /// same: other devices remember (and trust) this device by its fingerprint.
    pub fn load_or_create(dir: &Path) -> Result<Self, String> {
        let (cert_path, key_path) = (dir.join("post-cert.der"), dir.join("post-key.der"));
        if let (Ok(cert), Ok(key)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
            if !cert.is_empty() && !key.is_empty() {
                let fingerprint = fingerprint(&cert);
                return Ok(Self { cert, key, fingerprint });
            }
        }
        let key_pair = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
        params.distinguished_name.push(rcgen::DnType::CommonName, "ePet");
        let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;
        let (cert, key) = (cert.der().to_vec(), key_pair.serialize_der());
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        std::fs::write(&key_path, &key).map_err(|e| e.to_string())?;
        std::fs::write(&cert_path, &cert).map_err(|e| e.to_string())?;
        let fingerprint = fingerprint(&cert);
        Ok(Self { cert, key, fingerprint })
    }

    fn chain(&self) -> Vec<CertificateDer<'static>> {
        vec![CertificateDer::from(self.cert.clone())]
    }

    fn private_key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.clone()))
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn algorithms() -> WebPkiSupportedAlgorithms {
    rustls::crypto::ring::default_provider().signature_verification_algorithms
}

/// The server side: our certificate; a client may show its own (LocalSend does), which
/// tells us its fingerprint for sure.
pub fn server_config(id: &Identity) -> Result<Arc<rustls::ServerConfig>, String> {
    let config = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_client_cert_verifier(Arc::new(AnyClientCert { algs: algorithms() }))
        .with_single_cert(id.chain(), id.private_key())
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(config))
}

/// What the server saw of a connection's client certificate.
pub type SeenCert = Arc<Mutex<Option<String>>>;

/// The client side: shows our certificate, and accepts the server's only if its fingerprint
/// is `expected` (any, when we don't know it yet: a scan). `seen` gets the fingerprint.
pub fn client_config(id: &Identity, expected: Option<String>, seen: SeenCert) -> Result<rustls::ClientConfig, String> {
    let verifier = PinnedServer { expected: expected.map(|f| f.to_ascii_uppercase()), seen, algs: algorithms() };
    rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_client_auth_cert(id.chain(), id.private_key())
        .map_err(|e| e.to_string())
}

#[derive(Debug)]
struct AnyClientCert {
    algs: WebPkiSupportedAlgorithms,
}

impl ClientCertVerifier for AnyClientCert {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        // Browsers and some apps have none: their offers are simply never trusted.
        false
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        // Any certificate: it stands for a device, known by its fingerprint. The handshake
        // signature (below) proves the client holds its key.
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

#[derive(Debug)]
struct PinnedServer {
    expected: Option<String>,
    seen: SeenCert,
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinnedServer {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let actual = fingerprint(end_entity.as_ref());
        if self.expected.as_ref().is_some_and(|e| *e != actual) {
            return Err(Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure));
        }
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = Some(actual);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}
