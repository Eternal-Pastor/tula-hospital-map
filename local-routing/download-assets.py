from pathlib import Path
import urllib.request,json,hashlib,time,concurrent.futures
root=Path(__file__).resolve().parent

def read(url):
 with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'hospital-local-routing-setup'}),timeout=60) as r:return r.read()
def download(url,path,expected=None,algorithm='sha256'):
 if path.exists() and expected and hashlib.new(algorithm,path.read_bytes()).hexdigest()==expected:
  print(path.name+' already verified',flush=True);return
 part=path.with_suffix(path.suffix+'.part');h=hashlib.new(algorithm);last=time.monotonic();size=0
 with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'hospital-local-routing-setup'}),timeout=90) as r,part.open('wb') as f:
  total=int(r.headers.get('Content-Length',0));print(f'{path.name}: download {total/1048576:.1f} MiB',flush=True)
  while True:
   chunk=r.read(1024*1024)
   if not chunk:break
   f.write(chunk);h.update(chunk);size+=len(chunk)
   if time.monotonic()-last>=5:print(f'{path.name}: {size/1048576:.1f}/{total/1048576:.1f} MiB',flush=True);last=time.monotonic()
 if expected and h.hexdigest()!=expected:raise ValueError('Checksum mismatch: '+path.name)
 part.replace(path);print(f'{path.name}: verified {algorithm} {h.hexdigest()}',flush=True)
 return {'url':url,'file':str(path.relative_to(root)),'bytes':size,algorithm:h.hexdigest()}
def roads():
 url='https://download.geofabrik.de/russia/central-fed-district-latest.osm.pbf';md5=read(url+'.md5').decode().split()[0]
 result=download(url,root/'osrm/downloads/central-fed-district.osm.pbf',md5,'md5')
 if result:(root/'osrm/downloads/source.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
def wsl():
 release=json.loads(read('https://api.github.com/repos/microsoft/WSL/releases/latest'));asset=next(a for a in release['assets'] if a['name'].endswith('.x64.msi'))
 expected=asset.get('digest','').removeprefix('sha256:') or None
 result=download(asset['browser_download_url'],root/'runtime/wsl.x64.msi',expected)
 if result:(root/'runtime/wsl-source.json').write_text(json.dumps({'version':release['tag_name'],**result},indent=2),encoding='utf-8')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
 for future in [ex.submit(roads),ex.submit(wsl)]:future.result()
