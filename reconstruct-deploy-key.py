# Rebuild ~/.ssh/khafif_deploy from the vault-stored ed25519 seed (base64).
# Usage: python3 reconstruct-deploy-key.py  (reads seed from ./seed.b64 you supply)
import base64, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
seed = base64.b64decode(open('seed.b64').read().strip())
k = Ed25519PrivateKey.from_private_bytes(seed)
pem = k.private_bytes(Encoding.PEM, PrivateFormat.OpenSSH, NoEncryption())
open('khafif_deploy', 'wb').write(pem)
print('wrote khafif_deploy (chmod 600 it)')
