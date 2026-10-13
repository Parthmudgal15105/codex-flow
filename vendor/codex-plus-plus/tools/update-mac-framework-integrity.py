#!/usr/bin/env python3
"""Update a copied framework's integrity digest without disabling validation."""
import hashlib, plistlib, struct, sys
from pathlib import Path

def digest(app):
    entries=plistlib.loads((app/'Contents/Info.plist').read_bytes())['ElectronAsarIntegrity']
    result=hashlib.sha256()
    for key,entry in sorted(entries.items()):
        if entry['algorithm']!='SHA256' or len(entry['hash'])!=64:
            raise ValueError('Unsupported integrity entry')
        bytes.fromhex(entry['hash'])
        result.update((key+entry['algorithm']+entry['hash']).encode())
    return result.digest()

def slot(app):
    binary=(app/'Contents/Frameworks/Codex Framework.framework/Codex Framework').resolve()
    with binary.open('rb') as f:
        header=f.read(32)
        if struct.unpack_from('<I',header)[0]!=0xfeedfacf:
            raise ValueError('Expected a thin little-endian 64-bit Mach-O')
        count=struct.unpack_from('<I',header,16)[0]
        position=32
        for _ in range(count):
            f.seek(position);command,size=struct.unpack('<II',f.read(8))
            if size<8:raise ValueError('Invalid load command')
            if command==0x19:
                f.seek(position);segment=f.read(72)
                sections=struct.unpack_from('<I',segment,64)[0]
                for i in range(sections):
                    f.seek(position+72+i*80);section=f.read(80)
                    if section[:16].rstrip(b'\0')==b'__asar_integrity' and section[16:32].rstrip(b'\0')==b'__DATA_CONST':
                        length=struct.unpack_from('<Q',section,40)[0]
                        offset=struct.unpack_from('<I',section,48)[0]
                        if length!=66:raise ValueError('Unexpected integrity slot size')
                        f.seek(offset);value=f.read(66)
                        if value[:34]!=b'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A\x01\x01':
                            raise ValueError('Unexpected integrity slot marker')
                        return binary,offset,value[34:]
            position+=size
    raise ValueError('Missing integrity slot')

def update(source,target):
    source,target=source.resolve(),target.resolve()
    if source==target:raise ValueError('Refusing to modify the source app')
    _,_,original=slot(source)
    if original!=digest(source):raise ValueError('Source framework/plist mismatch')
    binary,offset,current=slot(target);expected=digest(target)
    if current==expected:
        print('Framework integrity already current');return
    if current!=original:raise ValueError('Copied framework has an unknown digest')
    with binary.open('r+b') as f:
        f.seek(offset+34);f.write(expected);f.flush()
    if slot(target)[2]!=expected:raise ValueError('Framework write verification failed')
    print('Framework integrity updated and verified; validation remains enabled')

if __name__=='__main__':update(Path(sys.argv[1]),Path(sys.argv[2]))
