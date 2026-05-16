# AWS EC2 기반 웹 서버 구축 실습

## 1. 프로젝트 개요
AWS EC2 인스턴스를 생성하고 Nginx 웹 서버를 설치하여 퍼블릭 IP로 접속 가능한 웹페이지를 배포한 실습입니다.

## 2. 사용 기술
- AWS EC2
- Amazon Linux 2023
- Nginx
- Security Group
- EC2 Instance Connect

## 3. 아키텍처
사용자 브라우저 → 퍼블릭 IP → EC2 인스턴스 → Nginx 웹 서버

## 4. 구축 과정
1. EC2 인스턴스 생성
2. 키 페어 생성
3. 보안 그룹 설정
   - SSH 22번 포트: 내 IP 허용
   - HTTP 80번 포트: 전체 허용
4. EC2 Instance Connect로 서버 접속
5. Nginx 설치 및 실행
6. index.html 수정
7. 퍼블릭 IPv4 주소로 접속 확인

## 5. 사용 명령어
```bash
sudo dnf update -y <서버에 설치된 패키지 목록/프로그램을 최신 상태로 업데이트>
sudo dnf install -y nginx <웹서버 프로그램인 Nginx를 설치>
sudo systemctl start nginx <Nginx를 실행>
sudo systemctl enable nginx <서버를 껐다 켜도 Nginx가 자동으로 켜지게 설정>
echo "<h1>Hello AWS EC2 - shk500</h1>" | sudo tee /usr/share/nginx/html/index.html <웹사이트 첫 화면 파일을 직접 만들어서, 브라우저에서 접속했을 때 저 문구가 보이게 함>
```
## 6. 멸령어 설명
| 명령어                                    | 설명                                |
| -------------------------------------- | --------------------------------- |
| `sudo dnf update -y`                   | 서버에 설치된 패키지 목록과 프로그램을 최신 상태로 업데이트 |
| `sudo dnf install -y nginx`            | Nginx 웹 서버 설치                     |
| `sudo systemctl start nginx`           | Nginx 서비스 실행                      |
| `sudo systemctl enable nginx`          | 서버 재시작 시 Nginx가 자동 실행되도록 설정       |
| `tee /usr/share/nginx/html/index.html` | Nginx 기본 웹 페이지 파일 수정              |



## 7. 트러블 슈팅
문제 1. EC2 Instance Connect 접속 실패
원인: SSH 22번 포트가 내 IP로 제한되어 EC2 Instance Connect 연결이 실패함
해결: 일시적으로 SSH 22번 포트를 0.0.0.0/0으로 변경해 접속 확인 후, 다시 내 IP로 제한함

문제 2. nginx.service not found 오류
원인: Nginx가 설치되지 않은 상태에서 systemctl start nginx 명령어를 실행함
해결: sudo dnf install -y nginx 명령어로 Nginx 설치 후 재실행함

## 8. 결과
퍼블릭 IPv4 주소로 접속했을 때 "Hello AWS EC2 - shk500" 페이지가 정상적으로 출력됨
